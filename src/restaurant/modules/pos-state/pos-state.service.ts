import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';

const ORDER_INCLUDE = {
  items: {
    include: { product: { select: { id: true, name: true, priceCOP: true } } },
  },
  kitchenTickets: { include: { items: true } },
  paymentSplits: { include: { contributions: true, items: true } },
} as const;

@Injectable()
export class PosStateService {
  constructor(private readonly prisma: PrismaService) {}

  async findCurrent(ctx: TenantContext) {
    const [tables, areas, orders, reservations] = await Promise.all([
      this.prisma.restaurantTable.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          deletedAt: null,
        },
        include: {
          area: { select: { id: true, name: true, emoji: true } },
        },
        orderBy: { code: 'asc' },
      }),
      this.prisma.area.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          deletedAt: null,
        },
        include: {
          _count: { select: { tables: { where: { deletedAt: null } } } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.order.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          status: 'OPEN',
        },
        include: ORDER_INCLUDE,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.reservation.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          status: 'ACTIVE',
        },
        orderBy: { scheduledAt: 'asc' },
      }),
    ]);

    const now = Date.now();
    const ordersByTable = new Map(orders.map((order) => [order.tableId, order]));

    return {
      tables: tables.map((table) => {
        const openOrder = ordersByTable.get(table.id);
        const totalCOP = openOrder
          ? openOrder.items.reduce((sum, item) => sum + item.priceCOP * item.qty, 0)
          : null;
        const minutesOpen = openOrder
          ? Math.floor((now - openOrder.createdAt.getTime()) / 60000)
          : null;

        return { ...table, totalCOP, minutesOpen };
      }),
      areas: areas.map(({ _count, ...area }) => ({
        ...area,
        tableCount: _count.tables,
      })),
      orders: orders.map((order) => this.mapOrder(order)),
      reservations: reservations.map((reservation) => this.mapReservation(reservation)),
    };
  }

  private mapOrder(order: any) {
    return {
      ...order,
      createdAt: order.createdAt.getTime(),
      closedAt: order.closedAt?.getTime() ?? null,
      totalCOP: order.items?.reduce(
        (sum: number, item: any) => sum + item.priceCOP * item.qty,
        0,
      ),
      kitchenTickets: order.kitchenTickets?.map((ticket: any) => ({
        ...ticket,
        sentAt: ticket.sentAt.getTime(),
        readyAt: ticket.readyAt?.getTime() ?? null,
        servedAt: ticket.servedAt?.getTime() ?? null,
      })),
      paymentSplits: order.paymentSplits?.map((split: any) => ({
        ...split,
        paidAt: split.paidAt.getTime(),
      })),
    };
  }

  private mapReservation(reservation: any) {
    return {
      id: reservation.id,
      tenantId: reservation.tenantId,
      branchId: reservation.branchId,
      tableId: reservation.tableId,
      guestName: reservation.guestName,
      guestPhone: reservation.guestPhone,
      partySize: reservation.partySize,
      scheduledAt: reservation.scheduledAt.getTime(),
      scheduledEnd: reservation.scheduledEnd?.getTime() ?? null,
      occasion: reservation.occasion,
      occasionNote: reservation.occasionNote,
      notes: reservation.notes,
      status: reservation.status,
      cancelReason: reservation.cancelReason,
      seatedAt: reservation.seatedAt?.getTime() ?? null,
      createdAt: reservation.createdAt.getTime(),
    };
  }
}
