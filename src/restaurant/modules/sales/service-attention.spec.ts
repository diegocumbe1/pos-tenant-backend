import { buildAttention } from './service-attention';

const ana = { actorId: 'u1', actorName: 'Ana', actorRole: 'WAITER' };
const luis = { actorId: 'u2', actorName: 'Luis', actorRole: 'WAITER' };
const duena = { actorId: 'u3', actorName: 'Diego', actorRole: 'OWNER' };

describe('buildAttention', () => {
  it('uno toma el pedido y otro lo entrega: queda separado', () => {
    const a = buildAttention([
      { type: 'OPENED', ...ana },
      { type: 'ITEM_ADDED', metadata: { deltaQty: 2 }, ...ana },
      { type: 'ITEM_ADDED', metadata: { deltaQty: 1 }, ...ana },
      { type: 'SENT_TO_KITCHEN', ticketId: 'k1', ...ana },
      { type: 'ITEM_SERVED', ticketId: 'k1', metadata: { deltaQty: 2 }, ...luis },
      { type: 'ITEM_SERVED', ticketId: 'k1', metadata: { deltaQty: 1 }, ...ana },
      { type: 'PAYMENT_REGISTERED', ...duena },
      { type: 'CLOSED', ...duena },
    ], 'Ana');
    expect(a.openedBy?.name).toBe('Ana');
    expect(a.takers).toEqual([expect.objectContaining({ name: 'Ana', units: 3 })]);
    expect(a.deliverers.map((d) => [d.name, d.units])).toEqual([['Luis', 2], ['Ana', 1]]);
    expect(a.payers[0]).toMatchObject({ name: 'Diego', role: 'OWNER' });
    expect(a.closedBy?.role).toBe('OWNER');
    expect(a.complete).toBe(true);
  });

  it('una entrega deshecha (delta negativo) no suma unidades', () => {
    const a = buildAttention([
      { type: 'OPENED', ...ana },
      { type: 'ITEM_SERVED', ticketId: 'k1', metadata: { deltaQty: 1 }, ...luis },
      { type: 'ITEM_SERVED', ticketId: 'k1', metadata: { deltaQty: -1 }, ...luis },
    ]);
    expect(a.deliverers).toEqual([expect.objectContaining({ name: 'Luis', units: 1 })]);
  });

  it('comandas servidas con la versión anterior (solo SERVED por comanda) no se pierden', () => {
    const a = buildAttention([
      { type: 'OPENED', ...ana },
      { type: 'SERVED', ticketId: 'k9', ...luis },
    ]);
    expect(a.deliverers[0]).toMatchObject({ name: 'Luis', units: 1 });
  });

  it('ventas anteriores al registro de actor quedan como "no completas", sin inventar nombres', () => {
    const a = buildAttention([
      { type: 'OPENED' },
      { type: 'ITEM_ADDED', metadata: { deltaQty: 2 } },
      { type: 'CLOSED' },
    ], 'Pedro');
    expect(a.takers).toEqual([]);
    expect(a.openedBy).toBeNull();
    expect(a.assignedWaiter).toBe('Pedro');
    expect(a.complete).toBe(false);
  });
});
