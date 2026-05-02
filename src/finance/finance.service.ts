import {
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { Period, PeriodQueryDto } from './dto/period-query.dto';

interface Range {
  from: Date;
  to: Date;
  label: Period;
}

@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboard(ctx: TenantContext, query: PeriodQueryDto) {
    const range = this.resolveRange(query);

    const splits = await this.prisma.paymentSplit.findMany({
      where: {
        tenantId: ctx.tenantId,
        order: { branchId: ctx.branchId },
        paidAt: { gte: range.from, lte: range.to },
      },
      include: {
        items: true,
        order: { select: { waiterId: true } },
      },
    });

    const expenses = await this.prisma.expense.aggregate({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        incurredAt: { gte: range.from, lte: range.to },
      },
      _sum: { amountCOP: true },
    });

    const revenue = splits.reduce((acc, s) => acc + s.totalCOP, 0);
    const expensesTotal = expenses._sum.amountCOP ?? 0;
    const profit = revenue - expensesTotal;
    const profitMarginPct =
      revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0;

    const ordersCount = new Set(splits.map((s) => s.orderId)).size;
    const averageOrderValue =
      ordersCount > 0 ? Math.round(revenue / ordersCount) : 0;

    const productMap = new Map<string, { name: string; revenue: number; quantity: number }>();
    for (const split of splits) {
      for (const item of split.items) {
        const entry = productMap.get(item.productId) ?? {
          name: item.name,
          revenue: 0,
          quantity: 0,
        };
        entry.revenue += item.priceCOP * item.qty;
        entry.quantity += item.qty;
        productMap.set(item.productId, entry);
      }
    }
    const topProductsByRevenue = [...productMap.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const waiterAgg = new Map<string, { revenue: number; orderIds: Set<string> }>();
    for (const split of splits) {
      const waiterId = split.order.waiterId;
      if (!waiterId) continue;
      const entry = waiterAgg.get(waiterId) ?? {
        revenue: 0,
        orderIds: new Set(),
      };
      entry.revenue += split.totalCOP;
      entry.orderIds.add(split.orderId);
      waiterAgg.set(waiterId, entry);
    }
    const waiterIds = [...waiterAgg.keys()];
    const waiters = waiterIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: waiterIds } },
          select: { id: true, name: true },
        })
      : [];
    const waiterNames = new Map(waiters.map((w) => [w.id, w.name]));
    const topWaitersByRevenue = [...waiterAgg.entries()]
      .map(([userId, v]) => ({
        userId,
        name: waiterNames.get(userId) ?? 'Unknown',
        revenue: v.revenue,
        ordersCount: v.orderIds.size,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    return {
      revenue,
      expenses: expensesTotal,
      profit,
      profitMarginPct,
      ordersCount,
      averageOrderValue,
      topProductsByRevenue,
      topWaitersByRevenue,
      period: range.label,
      dateFrom: range.from.toISOString(),
      dateTo: range.to.toISOString(),
    };
  }

  async expenses(ctx: TenantContext, query: PeriodQueryDto) {
    const range = this.resolveRange(query);
    const rows = await this.prisma.expense.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        incurredAt: { gte: range.from, lte: range.to },
      },
      orderBy: { incurredAt: 'desc' },
    });

    const byCategory = new Map<string, number>();
    let total = 0;
    for (const e of rows) {
      total += e.amountCOP;
      byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amountCOP);
    }

    return {
      total,
      byCategory: [...byCategory.entries()].map(([category, amount]) => ({
        category,
        amountCOP: amount,
      })),
      expenses: rows.map((e) => ({
        id: e.id,
        category: e.category,
        concept: e.concept,
        amountCOP: e.amountCOP,
        incurredAt: e.incurredAt.getTime(),
        note: e.note,
      })),
      period: range.label,
      dateFrom: range.from.toISOString(),
      dateTo: range.to.toISOString(),
    };
  }

  async payroll(ctx: TenantContext, query: PeriodQueryDto) {
    const { periodMonth, range } = this.resolvePayrollMonth(query);
    const rows = await this.prisma.payroll.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        periodMonth,
      },
      orderBy: { staffName: 'asc' },
    });

    const grossTotal = rows.reduce((a, r) => a + r.grossCOP, 0);
    const netTotal = rows.reduce((a, r) => a + r.netCOP, 0);

    return {
      periodMonth,
      grossTotal,
      netTotal,
      entries: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        staffName: r.staffName,
        role: r.role,
        grossCOP: r.grossCOP,
        netCOP: r.netCOP,
        paidAt: r.paidAt?.getTime() ?? null,
      })),
      dateFrom: range.from.toISOString(),
      dateTo: range.to.toISOString(),
    };
  }

  async goals(ctx: TenantContext, query: PeriodQueryDto) {
    const { periodMonth } = this.resolvePayrollMonth(query);
    const goals = await this.prisma.financeGoal.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        periodMonth,
      },
    });

    const monthStart = new Date(`${periodMonth}-01T00:00:00Z`);
    const monthEnd = new Date(monthStart);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);

    const [splitAgg, expenseAgg] = await Promise.all([
      this.prisma.paymentSplit.aggregate({
        where: {
          tenantId: ctx.tenantId,
          order: { branchId: ctx.branchId },
          paidAt: { gte: monthStart, lt: monthEnd },
        },
        _sum: { totalCOP: true },
      }),
      this.prisma.expense.aggregate({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          incurredAt: { gte: monthStart, lt: monthEnd },
        },
        _sum: { amountCOP: true },
      }),
    ]);

    const revenue = splitAgg._sum.totalCOP ?? 0;
    const expensesTotal = expenseAgg._sum.amountCOP ?? 0;
    const profit = revenue - expensesTotal;

    return {
      periodMonth,
      goals: goals.map((g) => {
        const actualCOP = g.metric === 'revenue' ? revenue : profit;
        const progressPct =
          g.targetCOP > 0
            ? Math.round((actualCOP / g.targetCOP) * 1000) / 10
            : 0;
        return {
          id: g.id,
          metric: g.metric,
          targetCOP: g.targetCOP,
          actualCOP,
          progressPct,
        };
      }),
    };
  }

  private resolveRange(query: PeriodQueryDto): Range {
    const period = query.period ?? 'today';
    const now = new Date();

    if (period === 'custom') {
      if (!query.dateFrom || !query.dateTo) {
        throw new UnprocessableEntityException(
          'dateFrom and dateTo required when period=custom',
        );
      }
      return {
        from: new Date(query.dateFrom),
        to: new Date(query.dateTo),
        label: 'custom',
      };
    }

    const from = new Date(now);
    const to = new Date(now);

    if (period === 'today') {
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
    } else if (period === 'week') {
      const day = from.getDay();
      const diff = (day + 6) % 7; // lunes como inicio
      from.setDate(from.getDate() - diff);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
    } else if (period === 'month') {
      from.setDate(1);
      from.setHours(0, 0, 0, 0);
      to.setMonth(to.getMonth() + 1, 0);
      to.setHours(23, 59, 59, 999);
    }

    return { from, to, label: period };
  }

  private resolvePayrollMonth(query: PeriodQueryDto) {
    const range = this.resolveRange(query);
    const periodMonth = `${range.from.getFullYear()}-${String(
      range.from.getMonth() + 1,
    ).padStart(2, '0')}`;
    return { periodMonth, range };
  }
}
