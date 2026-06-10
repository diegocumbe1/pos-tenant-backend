import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePlatformExpenseDto,
  CreatePaymentDto,
  PlatformFinanceQueryDto,
  SetFeatureOverrideDto,
  SetTenantStatusDto,
  UpdatePlanDto,
  UpdatePlatformExpenseDto,
  UpdatePlatformFinanceGoalDto,
  UpdateSubscriptionDto,
  UpsertPlatformFinanceGoalDto,
} from './dto/platform.dto';
import {
  FeatureOverrides,
  PLAN_FEATURES,
  resolveEffectiveFeatures,
  resolveFeatureValue,
} from './plans/plan-features';

type SubscriptionAction = 'activate' | 'suspend' | 'cancel';
type PlatformGoalMetric =
  | 'revenue_cop'
  | 'profit_cop'
  | 'mrr_cop'
  | 'payments_count'
  | 'active_tenants';

type PlatformFinanceRange = {
  from: Date;
  to: Date;
  period: 'today' | 'week' | 'month' | 'custom';
  periodMonth: string;
};

// La acción de suscripción refleja también el estado operativo del tenant (§10.4).
const ACTION_MAP: Record<
  SubscriptionAction,
  {
    sub: 'ACTIVE' | 'SUSPENDED' | 'CANCELED';
    tenant: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';
  }
> = {
  activate: { sub: 'ACTIVE', tenant: 'ACTIVE' },
  suspend: { sub: 'SUSPENDED', tenant: 'SUSPENDED' },
  cancel: { sub: 'CANCELED', tenant: 'INACTIVE' },
};

// Roles del BE → UserRole del FE (el FE usa ADMINISTRATIVE en vez de ADMIN).
const ROLE_CODE_MAP: Record<string, string> = { ADMIN: 'ADMINISTRATIVE' };

const VALID_FEATURE_KEYS = new Set(Object.keys(PLAN_FEATURES.BASIC));

@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Tenants ────────────────────────────────────────────────────────────────

  async listTenants() {
    const tenants = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      include: {
        vertical: { select: { code: true } },
        subscription: true,
        _count: { select: { users: true, branches: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { tenants: tenants.map((t) => this.toTenantDto(t)) };
  }

  async getTenant(id: string) {
    const tenant = await this.loadTenant(id);
    return {
      ...this.toTenantDto(tenant),
      features: resolveEffectiveFeatures(
        tenant.plan,
        this.readOverrides(tenant.featureOverrides),
      ),
    };
  }

  async updatePlan(id: string, dto: UpdatePlanDto, actorUserId: string) {
    const tenant = await this.loadTenant(id);
    const before = {
      plan: tenant.plan,
      subscriptionPlan: tenant.subscription?.plan,
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      const t = await tx.tenant.update({
        where: { id },
        data: { plan: dto.plan },
        include: this.tenantInclude(),
      });
      if (tenant.subscription) {
        await tx.subscription.update({
          where: { tenantId: id },
          data: { plan: dto.plan },
        });
      }
      return tx.tenant.findUniqueOrThrow({
        where: { id },
        include: this.tenantInclude(),
      });
    });

    await this.audit(actorUserId, 'tenant.plan', 'tenant', id, before, {
      plan: updated.plan,
      subscriptionPlan: updated.subscription?.plan,
    });
    return this.toTenantDto(updated);
  }

  async setFeatureOverride(
    id: string,
    dto: SetFeatureOverrideDto,
    actorUserId: string,
  ) {
    if (!VALID_FEATURE_KEYS.has(dto.feature)) {
      throw new BadRequestException(`Unknown feature: ${dto.feature}`);
    }
    if (
      dto.value !== null &&
      typeof dto.value !== 'boolean' &&
      typeof dto.value !== 'number'
    ) {
      throw new BadRequestException('value must be boolean, number or null');
    }

    const tenant = await this.loadTenant(id);
    const overrides = this.readOverrides(tenant.featureOverrides);
    const before = { ...overrides };

    if (dto.value === null) {
      delete overrides[dto.feature];
    } else {
      overrides[dto.feature] = dto.value;
    }

    const updated = await this.prisma.tenant.update({
      where: { id },
      data: {
        featureOverrides:
          Object.keys(overrides).length > 0
            ? (overrides as Prisma.InputJsonValue)
            : Prisma.JsonNull,
      },
      include: this.tenantInclude(),
    });

    await this.audit(
      actorUserId,
      'tenant.features',
      'tenant',
      id,
      before,
      overrides,
    );
    return this.toTenantDto(updated);
  }

  async clearOverrides(id: string, actorUserId: string) {
    const tenant = await this.loadTenant(id);
    const before = this.readOverrides(tenant.featureOverrides);

    const updated = await this.prisma.tenant.update({
      where: { id },
      data: { featureOverrides: Prisma.JsonNull },
      include: this.tenantInclude(),
    });

    await this.audit(
      actorUserId,
      'tenant.features.clear',
      'tenant',
      id,
      before,
      {},
    );
    return this.toTenantDto(updated);
  }

  async setTenantStatus(
    id: string,
    dto: SetTenantStatusDto,
    actorUserId: string,
  ) {
    const tenant = await this.loadTenant(id);
    const before = { status: tenant.status };

    const updated = await this.prisma.tenant.update({
      where: { id },
      data: { status: dto.status },
      include: this.tenantInclude(),
    });

    await this.audit(actorUserId, 'tenant.status', 'tenant', id, before, {
      status: updated.status,
    });
    return this.toTenantDto(updated);
  }

  async getUsage(id: string) {
    const tenant = await this.loadTenant(id);
    const [users, branches, terminalGroups] = await Promise.all([
      this.prisma.user.count({ where: { tenantId: id } }),
      this.prisma.branch.count({ where: { tenantId: id } }),
      this.prisma.cashSession.findMany({
        where: { tenantId: id },
        distinct: ['terminalId'],
        select: { terminalId: true },
      }),
    ]);

    const features = resolveEffectiveFeatures(
      tenant.plan,
      this.readOverrides(tenant.featureOverrides),
    );

    return {
      users,
      branches,
      terminals: terminalGroups.length,
      aiChatThisMonth: 0, // consumo real de IA: P2 (no instrumentado aún)
      limits: {
        maxUsers: features.maxUsers,
        maxBranches: features.maxBranches,
        maxTerminals: features.maxTerminals,
        maxTables: features.maxTables,
        maxMenuItems: features.maxMenuItems,
        aiChatMonthlyLimit: features.aiChatMonthlyLimit,
      },
    };
  }

  // ─── Usuarios del tenant ──────────────────────────────────────────────────────

  async listTenantUsers(tenantId: string) {
    await this.loadTenant(tenantId);
    const users = await this.prisma.user.findMany({
      where: { tenantId },
      include: {
        role: { select: { code: true } },
        userBranches: { select: { branchId: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return { users: users.map((u) => this.toTenantUserDto(u)) };
  }

  async setUserStatus(
    userId: string,
    status: 'ACTIVE' | 'DISABLED',
    actorUserId: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        role: { select: { code: true } },
        userBranches: { select: { branchId: true } },
      },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const isActive = status === 'ACTIVE';
    const before = { isActive: user.isActive };

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { isActive },
      include: {
        role: { select: { code: true } },
        userBranches: { select: { branchId: true } },
      },
    });

    await this.audit(actorUserId, 'user.status', 'user', userId, before, {
      isActive,
    });
    return this.toTenantUserDto(updated);
  }

  // ─── Suscripción ──────────────────────────────────────────────────────────────

  async getSubscription(tenantId: string) {
    await this.loadTenant(tenantId);
    const sub = await this.prisma.subscription.findUnique({
      where: { tenantId },
    });
    return sub ? this.toSubscriptionDto(sub) : null;
  }

  async updateSubscription(
    tenantId: string,
    dto: UpdateSubscriptionDto,
    actorUserId: string,
  ) {
    const tenant = await this.loadTenant(tenantId);
    const existing = await this.prisma.subscription.findUnique({
      where: { tenantId },
    });
    const before = existing ? this.toSubscriptionDto(existing) : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const sub = await this.ensureSubscription(tx, tenantId, tenant.plan);
      const s = await tx.subscription.update({
        where: { tenantId },
        data: {
          plan: dto.plan,
          billingCycle: dto.billingCycle,
          currentPeriodEnd: dto.currentPeriodEnd
            ? new Date(dto.currentPeriodEnd)
            : undefined,
          priceCOP: dto.priceCOP,
          priceUSD: dto.priceUSD,
        },
      });
      void sub;
      // Cambiar el plan en la suscripción lo refleja en el tenant (§3.5).
      if (dto.plan) {
        await tx.tenant.update({
          where: { id: tenantId },
          data: { plan: dto.plan },
        });
      }
      return s;
    });

    await this.audit(
      actorUserId,
      'subscription.update',
      'subscription',
      tenantId,
      before,
      this.toSubscriptionDto(updated),
    );
    return this.toSubscriptionDto(updated);
  }

  async setSubscriptionStatus(
    tenantId: string,
    action: SubscriptionAction,
    actorUserId: string,
    reason?: string,
  ) {
    const map = ACTION_MAP[action];
    if (!map) throw new BadRequestException(`Invalid action: ${action}`);

    const tenant = await this.loadTenant(tenantId);
    const existing = await this.prisma.subscription.findUnique({
      where: { tenantId },
    });
    const before = existing
      ? { subscriptionStatus: existing.status, canceledAt: existing.canceledAt }
      : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.ensureSubscription(tx, tenantId, tenant.plan);
      const s = await tx.subscription.update({
        where: { tenantId },
        data: {
          status: map.sub,
          canceledAt: action === 'cancel' ? new Date() : undefined,
        },
      });
      await tx.tenant.update({
        where: { id: tenantId },
        data: { status: map.tenant },
      });
      return s;
    });

    await this.audit(
      actorUserId,
      `subscription.${action}`,
      'subscription',
      tenantId,
      before,
      {
        subscriptionStatus: updated.status,
        tenantStatus: map.tenant,
        canceledAt: updated.canceledAt,
        reason: reason ?? null,
      },
    );
    return this.toSubscriptionDto(updated);
  }

  // ─── Pagos / facturación (§3.6) ───────────────────────────────────────────────

  async listPayments(tenantId: string) {
    await this.loadTenant(tenantId);
    const payments = await this.prisma.subscriptionPayment.findMany({
      where: { tenantId },
      orderBy: { paidAt: 'desc' },
    });
    return { payments: payments.map((p) => this.toPaymentDto(p)) };
  }

  async createPayment(
    tenantId: string,
    dto: CreatePaymentDto,
    actorUserId: string,
  ) {
    const tenant = await this.loadTenant(tenantId);
    const periodEnd = new Date(dto.periodEnd);
    const extend = dto.extendPeriod ?? true;

    const payment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.subscriptionPayment.create({
        data: {
          tenantId,
          plan: tenant.plan,
          amount: dto.amount,
          currency: dto.currency ?? 'COP',
          billingCycle:
            dto.billingCycle ?? tenant.subscription?.billingCycle ?? 'monthly',
          periodStart: new Date(dto.periodStart),
          periodEnd,
          paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
          method: dto.method ?? 'manual',
          reference: dto.reference,
          note: dto.note,
          createdByUserId: actorUserId,
        },
      });

      // Pago registrado → opcionalmente extiende el periodo y reactiva la cuenta.
      if (extend && tenant.subscription) {
        await tx.subscription.update({
          where: { tenantId },
          data: {
            currentPeriodEnd: periodEnd,
            status: 'ACTIVE',
            canceledAt: null,
          },
        });
        await tx.tenant.update({
          where: { id: tenantId },
          data: { status: 'ACTIVE' },
        });
      }
      return created;
    });

    await this.audit(
      actorUserId,
      'subscription.payment',
      'subscription',
      tenantId,
      null,
      { ...this.toPaymentDto(payment), extendedPeriod: extend },
    );
    return this.toPaymentDto(payment);
  }

  /**
   * Historial global de pagos (todos los tenants), opcionalmente filtrado por mes
   * `YYYY-MM`. Para la vista de "pagos por mes" del dashboard.
   */
  async listAllPayments(month?: string) {
    const where = month ? this.monthRange(month) : {};
    const payments = await this.prisma.subscriptionPayment.findMany({
      where,
      orderBy: { paidAt: 'desc' },
      take: 500,
      include: { tenant: { select: { id: true, name: true } } },
    });
    return {
      month: month ?? null,
      payments: payments.map((p) => ({
        ...this.toPaymentDto(p),
        tenantName: p.tenant.name,
      })),
    };
  }

  // ─── Dashboard / overview ──────────────────────────────────────────────────────

  async getOverview() {
    const [tenantsByStatus, subsByStatus, activeSubs, monthAgg] =
      await Promise.all([
        this.prisma.tenant.groupBy({
          by: ['status'],
          where: { deletedAt: null },
          _count: true,
        }),
        this.prisma.subscription.groupBy({ by: ['status'], _count: true }),
        this.prisma.subscription.findMany({
          where: { status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
          select: { billingCycle: true, priceCOP: true, priceUSD: true },
        }),
        this.prisma.subscriptionPayment.aggregate({
          where: this.monthRange(this.currentMonth()),
          _count: true,
          _sum: { amount: true },
        }),
      ]);

    // MRR aproximado: suma de precios de subs activas, normalizando anual /12.
    let mrrCOP = 0;
    let mrrUSD = 0;
    for (const s of activeSubs) {
      const div = s.billingCycle === 'yearly' ? 12 : 1;
      mrrCOP += Math.round((s.priceCOP ?? 0) / div);
      mrrUSD += Math.round((s.priceUSD ?? 0) / div);
    }

    return {
      tenants: {
        total: tenantsByStatus.reduce((acc, t) => acc + t._count, 0),
        byStatus: Object.fromEntries(
          tenantsByStatus.map((t) => [t.status, t._count]),
        ),
      },
      subscriptions: {
        byStatus: Object.fromEntries(
          subsByStatus.map((s) => [s.status, s._count]),
        ),
        mrrCOP,
        mrrUSD,
      },
      payments: {
        month: this.currentMonth(),
        count: monthAgg._count,
        totalAmount: monthAgg._sum.amount ?? 0,
      },
    };
  }

  // ─── Finanzas internas de plataforma ─────────────────────────────────────────

  async getPlatformFinanceDashboard(query: PlatformFinanceQueryDto) {
    const range = this.resolvePlatformFinanceRange(query);
    const [paymentGroups, expenseGroups, expensesByCategory, goals, mrr] =
      await Promise.all([
        this.prisma.subscriptionPayment.groupBy({
          by: ['currency'],
          where: { paidAt: { gte: range.from, lt: range.to } },
          _count: true,
          _sum: { amount: true },
        }),
        this.prisma.platformExpense.groupBy({
          by: ['currency'],
          where: { incurredAt: { gte: range.from, lt: range.to } },
          _count: true,
          _sum: { amount: true },
        }),
        this.prisma.platformExpense.groupBy({
          by: ['category', 'currency'],
          where: { incurredAt: { gte: range.from, lt: range.to } },
          _sum: { amount: true },
          orderBy: [{ category: 'asc' }, { currency: 'asc' }],
        }),
        this.prisma.platformFinanceGoal.findMany({
          where: { periodMonth: range.periodMonth },
          orderBy: { metric: 'asc' },
        }),
        this.calculateMrr(),
      ]);

    const revenue = this.moneyTotals(paymentGroups);
    const expenses = this.moneyTotals(expenseGroups);
    const activeTenants = await this.prisma.tenant.count({
      where: { deletedAt: null, status: 'ACTIVE' },
    });
    const actuals = this.platformGoalActuals({
      revenueCOP: revenue.COP,
      expensesCOP: expenses.COP,
      mrrCOP: mrr.mrrCOP,
      paymentsCount: paymentGroups.reduce((acc, row) => acc + row._count, 0),
      activeTenants,
    });

    return {
      period: range.period,
      periodMonth: range.periodMonth,
      dateFrom: range.from.toISOString(),
      dateTo: range.to.toISOString(),
      revenue,
      expenses,
      profit: {
        COP: revenue.COP - expenses.COP,
        USD: revenue.USD - expenses.USD,
      },
      mrr,
      activeTenants,
      paymentsCount: actuals.payments_count,
      expensesByCategory: expensesByCategory.map((row) => ({
        category: row.category,
        amount: row._sum.amount ?? 0,
        currency: row.currency,
      })),
      goals: goals.map((goal) =>
        this.toPlatformFinanceGoalDto(
          goal,
          actuals[goal.metric as PlatformGoalMetric] ?? 0,
        ),
      ),
    };
  }

  async listPlatformExpenses(query: PlatformFinanceQueryDto) {
    const range = this.resolvePlatformFinanceRange(query);
    const expenses = await this.prisma.platformExpense.findMany({
      where: { incurredAt: { gte: range.from, lt: range.to } },
      orderBy: { incurredAt: 'desc' },
    });
    return {
      period: range.period,
      dateFrom: range.from.toISOString(),
      dateTo: range.to.toISOString(),
      expenses: expenses.map((expense) => this.toPlatformExpenseDto(expense)),
    };
  }

  async createPlatformExpense(
    dto: CreatePlatformExpenseDto,
    actorUserId: string,
  ) {
    const expense = await this.prisma.platformExpense.create({
      data: {
        category: dto.category,
        concept: dto.concept,
        amount: dto.amount,
        currency: dto.currency ?? 'COP',
        incurredAt: new Date(dto.incurredAt),
        note: dto.note,
        createdByUserId: actorUserId,
      },
    });

    await this.audit(
      actorUserId,
      'platform.finance.expense.create',
      'platform_expense',
      expense.id,
      null,
      this.toPlatformExpenseDto(expense),
    );
    return this.toPlatformExpenseDto(expense);
  }

  async updatePlatformExpense(
    id: string,
    dto: UpdatePlatformExpenseDto,
    actorUserId: string,
  ) {
    const current = await this.prisma.platformExpense.findUnique({
      where: { id },
    });
    if (!current)
      throw new NotFoundException(`Platform expense ${id} not found`);

    const updated = await this.prisma.platformExpense.update({
      where: { id },
      data: {
        category: dto.category,
        concept: dto.concept,
        amount: dto.amount,
        currency: dto.currency,
        incurredAt: dto.incurredAt ? new Date(dto.incurredAt) : undefined,
        note: dto.note,
      },
    });

    await this.audit(
      actorUserId,
      'platform.finance.expense.update',
      'platform_expense',
      id,
      this.toPlatformExpenseDto(current),
      this.toPlatformExpenseDto(updated),
    );
    return this.toPlatformExpenseDto(updated);
  }

  async deletePlatformExpense(id: string, actorUserId: string) {
    const current = await this.prisma.platformExpense.findUnique({
      where: { id },
    });
    if (!current)
      throw new NotFoundException(`Platform expense ${id} not found`);

    await this.prisma.platformExpense.delete({ where: { id } });
    await this.audit(
      actorUserId,
      'platform.finance.expense.delete',
      'platform_expense',
      id,
      this.toPlatformExpenseDto(current),
      null,
    );
    return { ok: true, id };
  }

  async listPlatformFinanceGoals(month?: string) {
    const periodMonth = this.normalizeMonth(month ?? this.currentMonth());
    const goals = await this.prisma.platformFinanceGoal.findMany({
      where: { periodMonth },
      orderBy: { metric: 'asc' },
    });
    const actuals = await this.resolvePlatformGoalActuals(periodMonth);
    return {
      periodMonth,
      goals: goals.map((goal) =>
        this.toPlatformFinanceGoalDto(
          goal,
          actuals[goal.metric as PlatformGoalMetric] ?? 0,
        ),
      ),
    };
  }

  async upsertPlatformFinanceGoal(
    dto: UpsertPlatformFinanceGoalDto,
    actorUserId: string,
  ) {
    const periodMonth = this.normalizeMonth(dto.periodMonth);
    const existing = await this.prisma.platformFinanceGoal.findUnique({
      where: { periodMonth_metric: { periodMonth, metric: dto.metric } },
    });

    const goal = await this.prisma.platformFinanceGoal.upsert({
      where: { periodMonth_metric: { periodMonth, metric: dto.metric } },
      update: { target: dto.target },
      create: {
        periodMonth,
        metric: dto.metric,
        target: dto.target,
        createdByUserId: actorUserId,
      },
    });
    const actuals = await this.resolvePlatformGoalActuals(periodMonth);

    await this.audit(
      actorUserId,
      existing
        ? 'platform.finance.goal.update'
        : 'platform.finance.goal.create',
      'platform_finance_goal',
      goal.id,
      existing ? this.toPlatformFinanceGoalDto(existing) : null,
      this.toPlatformFinanceGoalDto(
        goal,
        actuals[goal.metric as PlatformGoalMetric] ?? 0,
      ),
    );
    return this.toPlatformFinanceGoalDto(
      goal,
      actuals[goal.metric as PlatformGoalMetric] ?? 0,
    );
  }

  async updatePlatformFinanceGoal(
    id: string,
    dto: UpdatePlatformFinanceGoalDto,
    actorUserId: string,
  ) {
    const current = await this.prisma.platformFinanceGoal.findUnique({
      where: { id },
    });
    if (!current) {
      throw new NotFoundException(`Platform finance goal ${id} not found`);
    }

    const updated = await this.prisma.platformFinanceGoal.update({
      where: { id },
      data: { target: dto.target },
    });
    const actuals = await this.resolvePlatformGoalActuals(updated.periodMonth);

    await this.audit(
      actorUserId,
      'platform.finance.goal.update',
      'platform_finance_goal',
      id,
      this.toPlatformFinanceGoalDto(current),
      this.toPlatformFinanceGoalDto(
        updated,
        actuals[updated.metric as PlatformGoalMetric] ?? 0,
      ),
    );
    return this.toPlatformFinanceGoalDto(
      updated,
      actuals[updated.metric as PlatformGoalMetric] ?? 0,
    );
  }

  async deletePlatformFinanceGoal(id: string, actorUserId: string) {
    const current = await this.prisma.platformFinanceGoal.findUnique({
      where: { id },
    });
    if (!current) {
      throw new NotFoundException(`Platform finance goal ${id} not found`);
    }

    await this.prisma.platformFinanceGoal.delete({ where: { id } });
    await this.audit(
      actorUserId,
      'platform.finance.goal.delete',
      'platform_finance_goal',
      id,
      this.toPlatformFinanceGoalDto(current),
      null,
    );
    return { ok: true, id };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private currentMonth(): string {
    return new Date().toISOString().slice(0, 7); // YYYY-MM
  }

  private monthRange(month: string): Prisma.SubscriptionPaymentWhereInput {
    const start = this.monthStart(month);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return { paidAt: { gte: start, lt: end } };
  }

  private monthStart(month: string): Date {
    const normalized = this.normalizeMonth(month);
    const start = new Date(`${normalized}-01T00:00:00.000Z`);
    if (Number.isNaN(start.getTime())) {
      throw new BadRequestException(
        `Invalid month (expected YYYY-MM): ${month}`,
      );
    }
    return start;
  }

  private normalizeMonth(month: string): string {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new BadRequestException(
        `Invalid month (expected YYYY-MM): ${month}`,
      );
    }
    return month;
  }

  private resolvePlatformFinanceRange(
    query: PlatformFinanceQueryDto,
  ): PlatformFinanceRange {
    const period = query.period ?? 'month';
    const now = new Date();

    if (period === 'custom') {
      if (!query.dateFrom || !query.dateTo) {
        throw new BadRequestException(
          'dateFrom and dateTo are required when period=custom',
        );
      }
      const from = new Date(query.dateFrom);
      const to = new Date(query.dateTo);
      if (
        Number.isNaN(from.getTime()) ||
        Number.isNaN(to.getTime()) ||
        from >= to
      ) {
        throw new BadRequestException('Invalid custom date range');
      }
      return {
        from,
        to,
        period,
        periodMonth: this.monthFromDate(from),
      };
    }

    const from = new Date(now);
    const to = new Date(now);

    if (period === 'today') {
      from.setHours(0, 0, 0, 0);
      to.setDate(to.getDate() + 1);
      to.setHours(0, 0, 0, 0);
    } else if (period === 'week') {
      const day = from.getDay();
      const diff = (day + 6) % 7;
      from.setDate(from.getDate() - diff);
      from.setHours(0, 0, 0, 0);
      to.setTime(from.getTime());
      to.setDate(to.getDate() + 7);
    } else {
      from.setDate(1);
      from.setHours(0, 0, 0, 0);
      to.setTime(from.getTime());
      to.setMonth(to.getMonth() + 1);
    }

    return {
      from,
      to,
      period,
      periodMonth: this.monthFromDate(from),
    };
  }

  private monthFromDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  private moneyTotals(
    groups: Array<{ currency: string; _sum: { amount: number | null } }>,
  ) {
    const totals: Record<'COP' | 'USD', number> = { COP: 0, USD: 0 };
    for (const row of groups) {
      if (row.currency === 'USD') totals.USD += row._sum.amount ?? 0;
      else totals.COP += row._sum.amount ?? 0;
    }
    return totals;
  }

  private async calculateMrr() {
    const activeSubs = await this.prisma.subscription.findMany({
      where: { status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
      select: { billingCycle: true, priceCOP: true, priceUSD: true },
    });

    let mrrCOP = 0;
    let mrrUSD = 0;
    for (const sub of activeSubs) {
      const div = sub.billingCycle === 'yearly' ? 12 : 1;
      mrrCOP += Math.round((sub.priceCOP ?? 0) / div);
      mrrUSD += Math.round((sub.priceUSD ?? 0) / div);
    }

    return { mrrCOP, mrrUSD };
  }

  private platformGoalActuals(input: {
    revenueCOP: number;
    expensesCOP: number;
    mrrCOP: number;
    paymentsCount: number;
    activeTenants: number;
  }): Record<PlatformGoalMetric, number> {
    return {
      revenue_cop: input.revenueCOP,
      profit_cop: input.revenueCOP - input.expensesCOP,
      mrr_cop: input.mrrCOP,
      payments_count: input.paymentsCount,
      active_tenants: input.activeTenants,
    };
  }

  private async resolvePlatformGoalActuals(periodMonth: string) {
    const start = this.monthStart(periodMonth);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const [payments, expenses, activeTenants, mrr] = await Promise.all([
      this.prisma.subscriptionPayment.groupBy({
        by: ['currency'],
        where: { paidAt: { gte: start, lt: end } },
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.platformExpense.groupBy({
        by: ['currency'],
        where: { incurredAt: { gte: start, lt: end } },
        _sum: { amount: true },
      }),
      this.prisma.tenant.count({
        where: { deletedAt: null, status: 'ACTIVE' },
      }),
      this.calculateMrr(),
    ]);
    const revenue = this.moneyTotals(payments);
    const expenseTotals = this.moneyTotals(expenses);
    return this.platformGoalActuals({
      revenueCOP: revenue.COP,
      expensesCOP: expenseTotals.COP,
      mrrCOP: mrr.mrrCOP,
      paymentsCount: payments.reduce((acc, row) => acc + row._count, 0),
      activeTenants,
    });
  }

  private toPaymentDto(
    p: Prisma.SubscriptionPaymentGetPayload<Record<string, never>>,
  ) {
    return {
      id: p.id,
      tenantId: p.tenantId,
      plan: p.plan,
      amount: p.amount,
      currency: p.currency,
      billingCycle: p.billingCycle,
      periodStart: p.periodStart.toISOString(),
      periodEnd: p.periodEnd.toISOString(),
      paidAt: p.paidAt.toISOString(),
      method: p.method,
      reference: p.reference ?? undefined,
      note: p.note ?? undefined,
      createdByUserId: p.createdByUserId,
      createdAt: p.createdAt.toISOString(),
    };
  }

  private toPlatformExpenseDto(
    expense: Prisma.PlatformExpenseGetPayload<Record<string, never>>,
  ) {
    return {
      id: expense.id,
      category: expense.category,
      concept: expense.concept,
      amount: expense.amount,
      currency: expense.currency,
      incurredAt: expense.incurredAt.toISOString(),
      note: expense.note ?? undefined,
      createdByUserId: expense.createdByUserId,
      createdAt: expense.createdAt.toISOString(),
      updatedAt: expense.updatedAt.toISOString(),
    };
  }

  private toPlatformFinanceGoalDto(
    goal: Prisma.PlatformFinanceGoalGetPayload<Record<string, never>>,
    actual = 0,
  ) {
    const progressPct =
      goal.target > 0 ? Math.round((actual / goal.target) * 1000) / 10 : 0;
    return {
      id: goal.id,
      periodMonth: goal.periodMonth,
      metric: goal.metric,
      target: goal.target,
      actual,
      progressPct,
      createdByUserId: goal.createdByUserId,
      createdAt: goal.createdAt.toISOString(),
      updatedAt: goal.updatedAt.toISOString(),
    };
  }

  private tenantInclude() {
    return {
      vertical: { select: { code: true } },
      subscription: true,
      _count: { select: { users: true, branches: true } },
    } satisfies Prisma.TenantInclude;
  }

  /**
   * Garantiza que el tenant tenga una suscripción; la crea (TRIALING/manual) si no
   * existe. Permite que el backoffice gestione la suscripción de cualquier tenant
   * (incluidos los creados por signup que nunca tuvieron una).
   */
  private async ensureSubscription(
    tx: Prisma.TransactionClient,
    tenantId: string,
    plan: string,
  ) {
    const existing = await tx.subscription.findUnique({ where: { tenantId } });
    if (existing) return existing;
    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);
    return tx.subscription.create({
      data: {
        tenantId,
        plan,
        status: 'TRIALING',
        billingCycle: 'monthly',
        currentPeriodStart: now,
        currentPeriodEnd: end,
        provider: 'manual',
      },
    });
  }

  private async loadTenant(id: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id, deletedAt: null },
      include: this.tenantInclude(),
    });
    if (!tenant) throw new NotFoundException(`Tenant ${id} not found`);
    return tenant;
  }

  private readOverrides(value: Prisma.JsonValue | null): FeatureOverrides {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ...(value as FeatureOverrides) };
    }
    return {};
  }

  private toTenantDto(
    tenant: Prisma.TenantGetPayload<{
      include: {
        vertical: { select: { code: true } };
        subscription: true;
        _count: { select: { users: true; branches: true } };
      };
    }>,
  ) {
    const overrides = this.readOverrides(tenant.featureOverrides);
    return {
      id: tenant.id,
      slug: slugify(tenant.name),
      name: tenant.name,
      plan: tenant.plan,
      planExpiresAt: tenant.subscription?.currentPeriodEnd?.toISOString(),
      createdAt: tenant.createdAt.toISOString(),
      vertical: tenant.vertical?.code ?? null,
      status: tenant.status,
      subscription: tenant.subscription
        ? this.toSubscriptionDto(tenant.subscription)
        : undefined,
      featureOverrides:
        Object.keys(overrides).length > 0 ? overrides : undefined,
      usersCount: tenant._count.users,
      branchesCount: tenant._count.branches,
    };
  }

  private toSubscriptionDto(
    sub: Prisma.SubscriptionGetPayload<Record<string, never>>,
  ) {
    return {
      id: sub.id,
      tenantId: sub.tenantId,
      plan: sub.plan,
      status: sub.status,
      billingCycle: sub.billingCycle,
      currentPeriodStart: sub.currentPeriodStart.toISOString(),
      currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
      trialEndsAt: sub.trialEndsAt?.toISOString(),
      canceledAt: sub.canceledAt?.toISOString(),
      priceCOP: sub.priceCOP ?? undefined,
      priceUSD: sub.priceUSD ?? undefined,
      provider: sub.provider,
      createdAt: sub.createdAt.toISOString(),
      updatedAt: sub.updatedAt.toISOString(),
    };
  }

  private toTenantUserDto(
    user: Prisma.UserGetPayload<{
      include: {
        role: { select: { code: true } };
        userBranches: { select: { branchId: true } };
      };
    }>,
  ) {
    return {
      id: user.id,
      tenantId: user.tenantId,
      clerkId: user.id, // identidad de auth (Supabase) — el FE conserva el campo
      name: user.name,
      email: user.email,
      role: ROLE_CODE_MAP[user.role.code] ?? user.role.code,
      branchIds: user.userBranches.map((ub) => ub.branchId),
      isActive: user.isActive,
      createdAt: user.createdAt.toISOString(),
    };
  }

  private async audit(
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string,
    before: unknown,
    after: unknown,
  ) {
    try {
      await this.prisma.platformAuditLog.create({
        data: {
          actorUserId,
          action,
          targetType,
          targetId,
          before: this.toJson(before),
          after: this.toJson(after),
        },
      });
    } catch (err) {
      // La auditoría no debe tumbar la mutación; se registra y sigue.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Audit log failed action=${action} target=${targetId}: ${msg}`,
      );
    }
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
