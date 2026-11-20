import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderEventType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { OrderEventsService } from '../order-events/order-events.service';
import { NotificationDispatcherService } from '../../../notifications/notification-dispatcher.service';
import {
  KITCHEN_TICKET_STATUSES,
  KitchenTicketStatus,
} from './dto/update-ticket-status.dto';
import {
  KITCHEN_TICKET_UPDATED,
  TABLE_UPDATED,
  KitchenTicketUpdatedEvent,
  TableUpdatedEvent,
} from '../../../realtime/realtime.events';

const TICKET_INCLUDE = {
  items: true,
  order: { select: { id: true, tableId: true, branchId: true } },
} as const;

@Injectable()
export class KitchenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly orderEvents: OrderEventsService,
    private readonly notifications: NotificationDispatcherService,
  ) {}

  async findTickets(ctx: TenantContext, status?: string) {
    const tickets = await this.prisma.kitchenTicket.findMany({
      where: {
        tenantId: ctx.tenantId,
        // Solo órdenes abiertas: cerrar o anular una orden no toca el estado de
        // sus comandas, y sin este filtro todo lo que quedó PENDING en órdenes
        // ya cobradas se acumulaba en el KDS para siempre.
        order: { branchId: ctx.branchId, status: 'OPEN' },
        ...(status ? { status } : {}),
      },
      include: TICKET_INCLUDE,
      orderBy: [{ priority: 'desc' }, { sentAt: 'asc' }],
    });

    return { tickets: tickets.map((t) => this.mapTicket(t)) };
  }

  async updateStatus(
    ctx: TenantContext,
    id: string,
    status: KitchenTicketStatus,
  ) {
    if (!KITCHEN_TICKET_STATUSES.includes(status)) {
      throw new UnprocessableEntityException(`Invalid status: ${status}`);
    }

    const existing = await this.prisma.kitchenTicket.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId,
        order: { branchId: ctx.branchId },
      },
      include: TICKET_INCLUDE,
    });
    if (!existing) throw new NotFoundException(`Kitchen ticket ${id} not found`);

    const now = new Date();
    const data: {
      status: KitchenTicketStatus;
      readyAt?: Date;
      servedAt?: Date;
    } = { status };
    if (status === 'READY' && !existing.readyAt) data.readyAt = now;
    if (status === 'SERVED') {
      data.servedAt = now;
      if (!existing.readyAt) data.readyAt = now;
    }

    const updated = await this.prisma.kitchenTicket.update({
      where: { id },
      data,
      include: TICKET_INCLUDE,
    });

    const mapped = this.mapTicket(updated);

    await this.recordKitchenEvents(ctx, updated.orderId, id, existing.status, status);

    this.events.emit(KITCHEN_TICKET_UPDATED, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      ticket: mapped,
    } satisfies KitchenTicketUpdatedEvent);

    if (status === 'READY') {
      this.events.emit(TABLE_UPDATED, {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        tableId: updated.order.tableId,
        reason: 'kitchen-ready',
      } satisfies TableUpdatedEvent);

      // Push por rol a mesera/cajero (best-effort).
      await this.notifications.dispatch({
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        vertical: 'restaurant',
        type: 'kitchen.ticket.ready',
        title: 'Pedido listo',
        body: 'Un pedido está listo para servir.',
        url: '/app',
        payload: { orderId: updated.orderId, ticketId: id },
        excludeUserId: ctx.userId,
      });
    }

    return mapped;
  }

  /**
   * Entrega parcial: marca cuántas unidades de cada línea ya están en la mesa.
   *
   * Sirve con y sin KDS: con KDS la cocina marca "listo" y la mesera confirma lo que
   * llegó; sin KDS (solo comandas impresas) la mesera es quien dice qué ya se entregó.
   * El estado de la comanda se DEDUCE de las líneas: SERVED cuando todas llegaron a su
   * cantidad; si se corrige una (se deshace) y estaba SERVED, vuelve a READY.
   */
  async markItemsServed(
    ctx: TenantContext,
    id: string,
    changes: { lineKey: string; servedQty: number }[],
  ) {
    const ticket = await this.prisma.kitchenTicket.findFirst({
      where: { id, tenantId: ctx.tenantId, order: { branchId: ctx.branchId } },
      include: TICKET_INCLUDE,
    });
    if (!ticket) throw new NotFoundException(`Kitchen ticket ${id} not found`);

    const byKey = new Map<string, any>(ticket.items.map((i: any) => [i.lineKey, i]));
    for (const c of changes) {
      const item = byKey.get(c.lineKey);
      if (!item) {
        throw new UnprocessableEntityException(`Línea ${c.lineKey} no está en la comanda`);
      }
      if (c.servedQty < 0 || c.servedQty > item.qty) {
        throw new UnprocessableEntityException(
          `servedQty de "${item.name}" debe estar entre 0 y ${item.qty}`,
        );
      }
    }

    // Bitácora: quién entregó qué (una fila por línea que cambió, con la diferencia).
    const deltas = changes
      .map((c) => {
        const item = byKey.get(c.lineKey);
        const previous = item.servedQty ?? 0;
        return { c, item, previous, deltaQty: c.servedQty - previous };
      })
      .filter((x) => x.deltaQty !== 0);
    await this.prisma.$transaction(
      changes.map((c) =>
        this.prisma.kitchenTicketItem.update({
          where: { ticketId_lineKey: { ticketId: id, lineKey: c.lineKey } },
          data: { servedQty: c.servedQty },
        }),
      ),
    );

    await this.orderEvents.recordMany(
      deltas.map(({ c, item, previous, deltaQty }) => ({
        tenantId: ctx.tenantId,
        orderId: ticket.orderId,
        actor: ctx,
        type: OrderEventType.ITEM_SERVED,
        ticketId: id,
        metadata: {
          lineKey: c.lineKey,
          productId: item.productId,
          name: item.name,
          qty: item.qty,
          previousServedQty: previous,
          newServedQty: c.servedQty,
          deltaQty,
        },
      })),
    );

    const fresh = await this.prisma.kitchenTicket.findFirstOrThrow({
      where: { id },
      include: TICKET_INCLUDE,
    });
    const allServed = fresh.items.every((i: any) => (i.servedQty ?? 0) >= i.qty);

    // Cambia de estado por el mismo camino de siempre (eventos, ALL_SERVED, realtime).
    if (allServed && fresh.status !== 'SERVED') {
      return this.updateStatus(ctx, id, 'SERVED');
    }
    if (!allServed && fresh.status === 'SERVED') {
      const reopened = await this.prisma.kitchenTicket.update({
        where: { id },
        data: { status: 'READY', servedAt: null },
        include: TICKET_INCLUDE,
      });
      return this.emitTicket(ctx, reopened);
    }
    return this.emitTicket(ctx, fresh);
  }

  private emitTicket(ctx: TenantContext, ticket: any) {
    const mapped = this.mapTicket(ticket);
    this.events.emit(KITCHEN_TICKET_UPDATED, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      ticket: mapped,
    } satisfies KitchenTicketUpdatedEvent);
    return mapped;
  }

  /** Bitácora de cocina + ALL_SERVED cuando todos los tickets quedan SERVED. */
  private async recordKitchenEvents(
    ctx: TenantContext,
    orderId: string,
    ticketId: string,
    fromStatus: string,
    status: KitchenTicketStatus,
  ) {
    const typeByStatus: Partial<Record<KitchenTicketStatus, OrderEventType>> = {
      PREPARING: OrderEventType.KITCHEN_PREPARING,
      READY: OrderEventType.KITCHEN_READY,
      SERVED: OrderEventType.SERVED,
    };
    const type = typeByStatus[status];
    if (!type) return;

    await this.orderEvents.record({
      tenantId: ctx.tenantId,
      orderId,
      actor: ctx,
      type,
      ticketId,
      metadata: {
        ticketId,
        fromStatus,
        toStatus: status,
      },
    });

    if (status === 'SERVED') {
      const remaining = await this.prisma.kitchenTicket.count({
        where: { orderId, status: { not: 'SERVED' } },
      });
      if (remaining === 0) {
        await this.orderEvents.record({
          tenantId: ctx.tenantId,
          orderId,
          actor: ctx,
          type: OrderEventType.ALL_SERVED,
          metadata: {
            ticketId,
            status: 'SERVED',
            allTicketsServed: true,
          },
        });
      }
    }
  }

  private mapTicket(ticket: any) {
    return {
      id: ticket.id,
      orderId: ticket.orderId,
      tableId: ticket.order?.tableId ?? null,
      status: ticket.status,
      priority: ticket.priority,
      sentAt: ticket.sentAt.getTime(),
      readyAt: ticket.readyAt?.getTime() ?? null,
      servedAt: ticket.servedAt?.getTime() ?? null,
      items: ticket.items.map((i: any) => ({
        id: i.id,
        productId: i.productId,
        lineKey: i.lineKey,
        name: i.name,
        qty: i.qty,
        servedQty: i.servedQty ?? 0,
        notes: i.notes ?? null,
        additions: i.additions ?? null,
        modifiers: i.modifiers ?? null,
      })),
    };
  }
}
