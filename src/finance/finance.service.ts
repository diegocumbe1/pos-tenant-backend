import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PayFrequency, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { Period, PeriodQueryDto } from './dto/period-query.dto';
import { PayrollQueryDto } from './dto/payroll-query.dto';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';
import { CreatePayrollDto, UpdatePayrollDto } from './dto/payroll.dto';
import {
  CreateFinanceGoalDto,
  UpdateFinanceGoalDto,
} from './dto/finance-goal.dto';

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

  async payroll(ctx: TenantContext, query: PayrollQueryDto) {
    const periodMonth = query.period ?? this.currentPeriodMonth();
    const rows = await this.prisma.payroll.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        periodMonth,
      },
      orderBy: { staffName: 'asc' },
    });

    const entries = rows.map((r) => {
      // grossCOP/netCOP se guardan POR PERÍODO de pago. Según la frecuencia,
      // multiplicamos por los ciclos de pago que caen en el mes.
      const cyclesInMonth = this.payCyclesInMonth(periodMonth, r.payFrequency);
      return {
        id: r.id,
        userId: r.userId,
        staffName: r.staffName,
        role: r.role,
        payFrequency: r.payFrequency,
        // Por período de pago
        grossCOP: r.grossCOP,
        netCOP: r.netCOP,
        bonusesCOP: r.bonusesCOP,
        deductionsCOP: r.deductionsCOP,
        // Consolidado del mes (frecuencia × ciclos)
        cyclesInMonth,
        monthlyGrossCOP: r.grossCOP * cyclesInMonth,
        monthlyNetCOP: r.netCOP * cyclesInMonth,
        paidAt: r.paidAt?.getTime() ?? null,
      };
    });

    const grossTotal = entries.reduce((a, e) => a + e.monthlyGrossCOP, 0);
    const netTotal = entries.reduce((a, e) => a + e.monthlyNetCOP, 0);

    // Límites del mes en hora Colombia (con TZ=America/Bogota el constructor local
    // arranca a medianoche Bogotá; new Date(y, m, 1) normaliza el cambio de año).
    const [pmYear, pmMonth] = periodMonth.split('-').map(Number);
    const monthStart = new Date(pmYear, pmMonth - 1, 1, 0, 0, 0, 0);
    const monthEnd = new Date(pmYear, pmMonth, 1, 0, 0, 0, 0);

    return {
      periodMonth,
      grossTotal,
      netTotal,
      entries,
      dateFrom: monthStart.toISOString(),
      dateTo: monthEnd.toISOString(),
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

    // Límites del mes en hora Colombia (con TZ=America/Bogota el constructor local
    // arranca a medianoche Bogotá; new Date(y, m, 1) normaliza el cambio de año).
    const [pmYear, pmMonth] = periodMonth.split('-').map(Number);
    const monthStart = new Date(pmYear, pmMonth - 1, 1, 0, 0, 0, 0);
    const monthEnd = new Date(pmYear, pmMonth, 1, 0, 0, 0, 0);

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

  // ─── Gastos (write) ──────────────────────────────────────────────────────

  async createExpense(ctx: TenantContext, dto: CreateExpenseDto) {
    const expense = await this.prisma.expense.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        category: dto.category,
        concept: dto.concept,
        amountCOP: dto.amountCOP,
        incurredAt: new Date(dto.incurredAt),
        note: dto.note ?? null,
      },
    });
    return this.toExpenseDto(expense);
  }

  async updateExpense(ctx: TenantContext, id: string, dto: UpdateExpenseDto) {
    await this.assertExpense(ctx, id);
    const expense = await this.prisma.expense.update({
      where: { id },
      data: {
        category: dto.category,
        concept: dto.concept,
        amountCOP: dto.amountCOP,
        incurredAt:
          dto.incurredAt !== undefined ? new Date(dto.incurredAt) : undefined,
        note: dto.note,
      },
    });
    return this.toExpenseDto(expense);
  }

  async removeExpense(ctx: TenantContext, id: string) {
    await this.assertExpense(ctx, id);
    await this.prisma.expense.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Nómina (write) ──────────────────────────────────────────────────────

  async createPayroll(ctx: TenantContext, dto: CreatePayrollDto) {
    try {
      const row = await this.prisma.payroll.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          userId: dto.userId ?? null,
          staffName: dto.staffName,
          role: dto.role,
          periodMonth: dto.periodMonth,
          payFrequency: dto.payFrequency ?? PayFrequency.MONTHLY,
          grossCOP: dto.grossCOP,
          netCOP: dto.netCOP,
          bonusesCOP: dto.bonusesCOP ?? 0,
          deductionsCOP: dto.deductionsCOP ?? 0,
          paidAt: dto.paidAt ? new Date(dto.paidAt) : null,
        },
      });
      return this.toPayrollDto(row);
    } catch (err) {
      throw this.mapUniqueViolation(
        err,
        'A payroll entry already exists for this staff and period',
      );
    }
  }

  async updatePayroll(ctx: TenantContext, id: string, dto: UpdatePayrollDto) {
    await this.assertPayroll(ctx, id);
    try {
      const row = await this.prisma.payroll.update({
        where: { id },
        data: {
          userId: dto.userId,
          staffName: dto.staffName,
          role: dto.role,
          periodMonth: dto.periodMonth,
          payFrequency: dto.payFrequency,
          grossCOP: dto.grossCOP,
          netCOP: dto.netCOP,
          bonusesCOP: dto.bonusesCOP,
          deductionsCOP: dto.deductionsCOP,
          paidAt:
            dto.paidAt === undefined
              ? undefined
              : dto.paidAt === null
                ? null
                : new Date(dto.paidAt),
        },
      });
      return this.toPayrollDto(row);
    } catch (err) {
      throw this.mapUniqueViolation(
        err,
        'A payroll entry already exists for this staff and period',
      );
    }
  }

  async removePayroll(ctx: TenantContext, id: string) {
    await this.assertPayroll(ctx, id);
    await this.prisma.payroll.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Metas (write) ───────────────────────────────────────────────────────

  async createGoal(ctx: TenantContext, dto: CreateFinanceGoalDto) {
    try {
      const goal = await this.prisma.financeGoal.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          periodMonth: dto.periodMonth,
          metric: dto.metric,
          targetCOP: dto.targetCOP,
        },
      });
      return this.toGoalDto(goal);
    } catch (err) {
      throw this.mapUniqueViolation(
        err,
        'A goal already exists for this metric and period',
      );
    }
  }

  async updateGoal(ctx: TenantContext, id: string, dto: UpdateFinanceGoalDto) {
    await this.assertGoal(ctx, id);
    try {
      const goal = await this.prisma.financeGoal.update({
        where: { id },
        data: {
          periodMonth: dto.periodMonth,
          metric: dto.metric,
          targetCOP: dto.targetCOP,
        },
      });
      return this.toGoalDto(goal);
    } catch (err) {
      throw this.mapUniqueViolation(
        err,
        'A goal already exists for this metric and period',
      );
    }
  }

  async removeGoal(ctx: TenantContext, id: string) {
    await this.assertGoal(ctx, id);
    await this.prisma.financeGoal.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Helpers de escritura ────────────────────────────────────────────────

  private async assertExpense(ctx: TenantContext, id: string) {
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException(`Expense ${id} not found`);
  }

  private async assertPayroll(ctx: TenantContext, id: string) {
    const row = await this.prisma.payroll.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException(`Payroll ${id} not found`);
  }

  private async assertGoal(ctx: TenantContext, id: string) {
    const row = await this.prisma.financeGoal.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException(`Goal ${id} not found`);
  }

  private mapUniqueViolation(err: unknown, message: string) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return new ConflictException(message);
    }
    return err;
  }

  private toExpenseDto(e: {
    id: string;
    category: string;
    concept: string;
    amountCOP: number;
    incurredAt: Date;
    note: string | null;
  }) {
    return {
      id: e.id,
      category: e.category,
      concept: e.concept,
      amountCOP: e.amountCOP,
      incurredAt: e.incurredAt.getTime(),
      note: e.note,
    };
  }

  private toPayrollDto(r: {
    id: string;
    userId: string | null;
    staffName: string;
    role: string;
    periodMonth: string;
    payFrequency: PayFrequency;
    grossCOP: number;
    netCOP: number;
    bonusesCOP: number;
    deductionsCOP: number;
    paidAt: Date | null;
  }) {
    const cyclesInMonth = this.payCyclesInMonth(r.periodMonth, r.payFrequency);
    return {
      id: r.id,
      userId: r.userId,
      staffName: r.staffName,
      role: r.role,
      periodMonth: r.periodMonth,
      payFrequency: r.payFrequency,
      grossCOP: r.grossCOP,
      netCOP: r.netCOP,
      bonusesCOP: r.bonusesCOP,
      deductionsCOP: r.deductionsCOP,
      cyclesInMonth,
      monthlyGrossCOP: r.grossCOP * cyclesInMonth,
      monthlyNetCOP: r.netCOP * cyclesInMonth,
      paidAt: r.paidAt?.getTime() ?? null,
    };
  }

  private toGoalDto(g: {
    id: string;
    periodMonth: string;
    metric: string;
    targetCOP: number;
  }) {
    return {
      id: g.id,
      periodMonth: g.periodMonth,
      metric: g.metric,
      targetCOP: g.targetCOP,
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

  private currentPeriodMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Ciclos de pago que caen dentro del mes según la frecuencia.
   * - MONTHLY: 1
   * - BIWEEKLY (quincenal): 2
   * - WEEKLY: cuenta los viernes (día de pago) del mes → 4 o 5
   */
  private payCyclesInMonth(periodMonth: string, freq: PayFrequency): number {
    if (freq === PayFrequency.MONTHLY) return 1;
    if (freq === PayFrequency.BIWEEKLY) return 2;

    const [year, month] = periodMonth.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    let fridays = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === 5) fridays++;
    }
    return fridays;
  }
}
