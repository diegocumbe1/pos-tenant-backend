import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CashMovementType,
  ClaimSeverity,
  OrderClaim,
  OrderEvent,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { dayStartCO, dayEndCO } from '../../../common/date.util';
import { OrderEventsService } from '../order-events/order-events.service';
import { computeTimings } from './sales-timings';
import { CreateClaimDto } from './dto/create-claim.dto';

const SALE_INCLUDE = {
  items: true,
  table: { select: { code: true } },
  waiter: { select: { name: true } },
  paymentSplits: { include: { contributions: true, items: true } },
  events: true,
  claims: true,
} as const;

type SaleOrder = Prisma.OrderGetPayload<{ include: typeof SALE_INCLUDE }>;

const BUSINESS_TZ = 'America/Bogota';

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orderEvents: OrderEventsService,
  ) {}

  async list(ctx: TenantContext, from?: string, to?: string, terminalId?: string) {
    const orders = await this.prisma.order.findMany({
      where: this.rangeWhere(ctx, from, to, terminalId),
      include: SALE_INCLUDE,
      orderBy: { closedAt: 'desc' },
    });
    const sessionByOrder = await this.cashSessionByOrder(orders.map((o) => o.id));
    return {
      sales: orders.map((o) => this.toSaleRecord(o, sessionByOrder.get(o.id))),
    };
  }

  async daily(ctx: TenantContext, from?: string, to?: string) {
    const orders = await this.prisma.order.findMany({
      where: this.rangeWhere(ctx, from, to),
      include: { items: true, paymentSplits: { include: { contributions: true } } },
      orderBy: { closedAt: 'asc' },
    });

    const byDay = new Map<
      string,
      {
        businessDay: string;
        salesCount: number;
        itemsCount: number;
        totalCOP: number;
        byMethod: Map<string, { total: number; count: number }>;
      }
    >();

    for (const o of orders) {
      const day = this.businessDay(o.closedAt!);
      const entry =
        byDay.get(day) ??
        {
          businessDay: day,
          salesCount: 0,
          itemsCount: 0,
          totalCOP: 0,
          byMethod: new Map<string, { total: number; count: number }>(),
        };
      const subtotal = o.items.reduce((s, i) => s + i.priceCOP * i.qty, 0);
      entry.salesCount += 1;
      entry.itemsCount += o.items.reduce((s, i) => s + i.qty, 0);
      entry.totalCOP += o.totalCOP ?? subtotal;
      for (const split of o.paymentSplits) {
        for (const c of split.contributions) {
          const m = entry.byMethod.get(c.method) ?? { total: 0, count: 0 };
          m.total += c.amount;
          m.count += 1;
          entry.byMethod.set(c.method, m);
        }
      }
      byDay.set(day, entry);
    }

    // DailySalesSummary (Anexo A §A3): itemsCount + byMethod{method,total,count}.
    const summaries = [...byDay.values()].map((e) => ({
      businessDay: e.businessDay,
      salesCount: e.salesCount,
      itemsCount: e.itemsCount,
      totalCOP: e.totalCOP,
      byMethod: [...e.byMethod].map(([method, v]) => ({
        method,
        total: v.total,
        count: v.count,
      })),
    }));
    return { summaries };
  }

  async findOne(ctx: TenantContext, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: SALE_INCLUDE,
    });
    if (!order) throw new NotFoundException(`Sale ${id} not found`);

    const sessionByOrder = await this.cashSessionByOrder([order.id]);
    const receipt = await this.prisma.receiptShare.findFirst({
      where: { tenantId: ctx.tenantId, orderId: order.id, splitId: null },
      orderBy: { createdAt: 'desc' },
    });

    const record = this.toSaleRecord(order, sessionByOrder.get(order.id));
    return {
      ...record,
      receiptDocument: receipt?.payload ?? null,
    };
  }

  // POST /orders/:id/claims
  async addClaim(ctx: TenantContext, orderId: string, dto: CreateClaimDto) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: { id: true },
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);

    const severity = (dto.severity?.toUpperCase() ?? 'MEDIUM') as ClaimSeverity;
    const claim = await this.prisma.orderClaim.create({
      data: {
        tenantId: ctx.tenantId,
        orderId,
        description: dto.description,
        severity,
        byUserId: ctx.userId,
        byUserName: dto.byUserName ?? ctx.name,
      },
    });
    await this.orderEvents.record({
      tenantId: ctx.tenantId,
      orderId,
      type: 'CLAIM',
      note: dto.description,
    });
    return this.mapClaim(claim);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────
  private rangeWhere(
    ctx: TenantContext,
    from?: string,
    to?: string,
    terminalId?: string,
  ): Prisma.OrderWhereInput {
    return {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      status: 'CLOSED',
      ...(terminalId ? { terminalId } : {}),
      ...(from || to
        ? {
            closedAt: {
              ...(from ? { gte: dayStartCO(from) } : {}),
              ...(to ? { lte: dayEndCO(to) } : {}),
            },
          }
        : {}),
    };
  }

  private async cashSessionByOrder(orderIds: string[]) {
    const map = new Map<string, string>();
    if (orderIds.length === 0) return map;
    const movements = await this.prisma.cashMovement.findMany({
      where: { type: CashMovementType.SALE, reference: { in: orderIds } },
      select: { reference: true, sessionId: true },
    });
    for (const m of movements) {
      if (m.reference) map.set(m.reference, m.sessionId);
    }
    return map;
  }

  private toSaleRecord(order: SaleOrder, cashSessionId?: string) {
    const subtotalCOP = order.items.reduce(
      (s, i) => s + i.priceCOP * i.qty,
      0,
    );
    const payments = order.paymentSplits.flatMap((split) =>
      split.contributions.map((c) => ({
        method: c.method,
        amount: c.amount,
        cardType: c.cardType ?? undefined,
      })),
    );

    return {
      id: order.id,
      tenantId: order.tenantId,
      branchId: order.branchId,
      terminalId: order.terminalId ?? undefined,
      orderId: order.id,
      tableCode: order.table?.code ?? undefined,
      waiterName: order.waiter?.name ?? undefined,
      items: order.items.map((i) => ({
        productId: i.productId,
        name: i.name,
        qty: i.qty,
        priceCOP: i.priceCOP,
      })),
      payments,
      subtotalCOP,
      totalCOP: order.totalCOP ?? subtotalCOP,
      closedAt: order.closedAt?.toISOString() ?? null,
      businessDay: order.closedAt ? this.businessDay(order.closedAt) : null,
      events: order.events
        .slice()
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .map((e) => this.mapEvent(e)),
      timings: computeTimings(order.events, order.closedAt),
      claims: order.claims.map((c) => this.mapClaim(c)),
      cashSessionId: cashSessionId ?? undefined,
    };
  }

  private mapEvent(e: OrderEvent) {
    return {
      id: e.id,
      orderId: e.orderId,
      type: e.type, // enum en MAYÚSCULA, tal cual lo espera el front
      at: e.at.toISOString(),
      ticketId: e.ticketId ?? undefined,
      note: e.note ?? undefined,
      metadata: e.metadata ?? undefined,
    };
  }

  // Shape FE (Anexo A §A1): severity minúscula, `byUser` plano (nombre).
  private mapClaim(c: OrderClaim) {
    return {
      id: c.id,
      at: c.at.toISOString(),
      description: c.description,
      severity: c.severity.toLowerCase(), // low | medium | high
      byUser: c.byUserName ?? undefined,
      resolution: c.resolution ?? undefined,
      resolvedAt: c.resolvedAt?.toISOString() ?? undefined,
    };
  }

  private businessDay(date: Date) {
    // YYYY-MM-DD en zona horaria operativa.
    return date.toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
  }
}
