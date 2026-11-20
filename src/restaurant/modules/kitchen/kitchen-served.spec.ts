import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { KitchenService } from './kitchen.service';

const ctx = { tenantId: 't1', branchId: 'b1', userId: 'u1', name: 'Ana', roleCode: 'WAITER' } as never;

function build(status = 'READY', items = [
  { lineKey: 'a', name: 'Bistec', qty: 2, servedQty: 0 },
  { lineKey: 'b', name: 'Jugo', qty: 1, servedQty: 0 },
]) {
  const state = { status, items: items.map((i) => ({ ...i })) };
  const ticket = () => ({
    id: 'k1', orderId: 'o1', status: state.status, priority: 'normal',
    sentAt: new Date(), readyAt: null, servedAt: null,
    order: { id: 'o1', tableId: 'tb1', branchId: 'b1' },
    items: state.items,
  });
  const prisma = {
    kitchenTicket: {
      findFirst: jest.fn(async () => ticket()),
      findFirstOrThrow: jest.fn(async () => ticket()),
      update: jest.fn(async ({ data }) => { Object.assign(state, data); return ticket(); }),
      count: jest.fn(async () => 0),
    },
    kitchenTicketItem: {
      update: jest.fn(({ where, data }) => {
        const it = state.items.find((i) => i.lineKey === where.ticketId_lineKey.lineKey)!;
        Object.assign(it, data);
        return it;
      }),
    },
    $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops)),
  };
  const events = { emit: jest.fn() };
  const orderEvents = { record: jest.fn(), recordMany: jest.fn() };
  const notifications = { dispatch: jest.fn() };
  const service = new KitchenService(prisma as never, events as never, orderEvents as never, notifications as never);
  return { service, prisma, events, state, orderEvents };
}

describe('KitchenService.markItemsServed', () => {
  it('entrega parcial: guarda lo entregado y la comanda NO pasa a SERVED', async () => {
    const { service, state, events } = build();
    const r = await service.markItemsServed(ctx, 'k1', [{ lineKey: 'a', servedQty: 1 }]);
    expect(state.items[0].servedQty).toBe(1);
    expect(r.status).toBe('READY');
    expect(r.items[0].servedQty).toBe(1);
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('deja en la bitácora QUIÉN entregó qué, con la diferencia', async () => {
    const { service, orderEvents } = build();
    await service.markItemsServed(ctx, 'k1', [{ lineKey: 'a', servedQty: 1 }]);
    const rows = orderEvents.recordMany.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'ITEM_SERVED',
      actor: { userId: 'u1', name: 'Ana', roleCode: 'WAITER' },
      metadata: { lineKey: 'a', name: 'Bistec', previousServedQty: 0, newServedQty: 1, deltaQty: 1 },
    });
  });

  it('si no cambia nada no escribe eventos', async () => {
    const { service, orderEvents } = build();
    await service.markItemsServed(ctx, 'k1', [{ lineKey: 'a', servedQty: 0 }]);
    expect(orderEvents.recordMany.mock.calls[0][0]).toHaveLength(0);
  });

  it('cuando todas las líneas llegan a su cantidad, la comanda pasa a SERVED', async () => {
    const { service, state } = build();
    const r = await service.markItemsServed(ctx, 'k1', [
      { lineKey: 'a', servedQty: 2 }, { lineKey: 'b', servedQty: 1 },
    ]);
    expect(state.status).toBe('SERVED');
    expect(r.status).toBe('SERVED');
  });

  it('si se corrige una línea y la comanda estaba SERVED, vuelve a READY', async () => {
    const { service, state } = build('SERVED', [
      { lineKey: 'a', name: 'Bistec', qty: 2, servedQty: 2 },
      { lineKey: 'b', name: 'Jugo', qty: 1, servedQty: 1 },
    ]);
    const r = await service.markItemsServed(ctx, 'k1', [{ lineKey: 'b', servedQty: 0 }]);
    expect(state.status).toBe('READY');
    expect(r.status).toBe('READY');
  });

  it('rechaza más unidades de las pedidas, negativos y líneas ajenas', async () => {
    const { service, prisma } = build();
    await expect(service.markItemsServed(ctx, 'k1', [{ lineKey: 'a', servedQty: 3 }])).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.markItemsServed(ctx, 'k1', [{ lineKey: 'a', servedQty: -1 }])).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.markItemsServed(ctx, 'k1', [{ lineKey: 'zz', servedQty: 1 }])).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.kitchenTicketItem.update).not.toHaveBeenCalled();
  });

  it('comanda inexistente o de otra sede → 404', async () => {
    const { service, prisma } = build();
    prisma.kitchenTicket.findFirst.mockResolvedValueOnce(null as never);
    await expect(service.markItemsServed(ctx, 'x', [{ lineKey: 'a', servedQty: 1 }])).rejects.toBeInstanceOf(NotFoundException);
  });
});
