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
  ) {}

  async findTickets(ctx: TenantContext, status?: string) {
    const tickets = await this.prisma.kitchenTicket.findMany({
      where: {
        tenantId: ctx.tenantId,
        order: { branchId: ctx.branchId },
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
    }

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
        name: i.name,
        qty: i.qty,
      })),
    };
  }
}
