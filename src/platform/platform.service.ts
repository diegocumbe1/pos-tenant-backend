import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { dayEndCO, dayStartCO } from '../common/date.util';
import { GRACE_DAYS } from './platform.constants';
import {
  CreatePlatformExpenseDto,
  CreatePaymentDto,
  CreateRecurringExpenseDto,
  PlatformFinanceQueryDto,
  SetFeatureOverrideDto,
  SetTenantStatusDto,
  UpdateBillingContactDto,
  UpdatePlanDto,
  UpdatePlatformExpenseDto,
  UpdatePlatformFinanceGoalDto,
  UpdatePricingConfigDto,
  UpdateRecurringExpenseDto,
  UpdateSubscriptionDto,
  UpsertBillingContactDto,
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

// GRACE_DAYS vive en platform.constants para que la mensajería calcule la misma
// fecha de suspensión que muestra esta consola.

// Cuántos meses representa cada ciclo, para mensualizar compromisos recurrentes
// y calcular el burn rate mensual de la plataforma.
const RECURRENCE_MONTHS: Record<string, number> = {
  weekly: 1 / 4.345,
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

const VALID_FEATURE_KEYS = new Set(Object.keys(PLAN_FEATURES.BASIC));
const PLATFORM_PRICING_CONFIG_ID = 'singleton';
const DEFAULT_USD_TO_COP_RATE = 3650;

@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Configuracion comercial global ─────────────────────────────────────────

  async getPricingConfig() {
    const config = await this.ensurePricingConfig();
    return this.toPricingConfigDto(config);
  }

  async updatePricingConfig(dto: UpdatePricingConfigDto, actorUserId: string) {
    const rate = dto.rate ?? dto.usdToCopRate;
    if (!Number.isFinite(rate) || !rate || rate <= 0) {
      throw new BadRequestException('rate must be a positive integer');
    }

    const current = await this.ensurePricingConfig();
    const updated = await this.prisma.platformPricingConfig.update({
      where: { id: PLATFORM_PRICING_CONFIG_ID },
      data: {
        usdToCopRate: Math.round(rate),
        updatedBy: actorUserId,
      },
    });

    await this.audit(
      actorUserId,
      'platform.pricing.update',
      'platform_pricing_config',
      PLATFORM_PRICING_CONFIG_ID,
      this.toPricingConfigDto(current),
      this.toPricingConfigDto(updated),
    );
    return this.toPricingConfigDto(updated);
  }

  async resetPricingConfig(actorUserId: string) {
    const current = await this.ensurePricingConfig();
    const updated = await this.prisma.platformPricingConfig.update({
      where: { id: PLATFORM_PRICING_CONFIG_ID },
      data: {
        usdToCopRate: DEFAULT_USD_TO_COP_RATE,
        updatedBy: actorUserId,
      },
    });

    await this.audit(
      actorUserId,
      'platform.pricing.reset',
      'platform_pricing_config',
      PLATFORM_PRICING_CONFIG_ID,
      this.toPricingConfigDto(current),
      this.toPricingConfigDto(updated),
    );
    return this.toPricingConfigDto(updated);
  }

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

  /**
   * Cockpit operativo de solo-lectura para super-admin: sedes, usuarios,
   * productos, inventario, mesas y últimas órdenes de un tenant, sin necesidad
   * de impersonar. Devuelve conteos + listas acotadas para observabilidad.
   */
  async getTenantOperations(id: string) {
    await this.loadTenant(id);

    const [
      branches,
      users,
      productCategories,
      products,
      ingredients,
      areas,
      tables,
      recentOrders,
      counts,
    ] = await Promise.all([
      this.prisma.branch.findMany({
        where: { tenantId: id },
        select: {
          id: true,
          name: true,
          address: true,
          phone: true,
          createdAt: true,
          _count: {
            select: {
              userBranches: true,
              products: true,
              ingredients: true,
              tables: true,
              orders: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.user.findMany({
        where: { tenantId: id },
        include: {
          role: { select: { code: true } },
          userBranches: { select: { branchId: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
      this.prisma.productCategory.findMany({
        where: { tenantId: id },
        select: {
          id: true,
          branchId: true,
          name: true,
          emoji: true,
          sortOrder: true,
          _count: { select: { products: true } },
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        take: 50,
      }),
      this.prisma.product.findMany({
        where: { tenantId: id, deletedAt: null },
        select: {
          id: true,
          branchId: true,
          categoryId: true,
          name: true,
          priceCOP: true,
          emoji: true,
          isAvailable: true,
          sortOrder: true,
          createdAt: true,
          updatedAt: true,
          category: { select: { name: true } },
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        take: 50,
      }),
      this.prisma.ingredient.findMany({
        where: { tenantId: id, isActive: true },
        select: {
          id: true,
          branchId: true,
          categoryId: true,
          name: true,
          recipeUnit: true,
          currentStock: true,
          minStock: true,
          netUnitCost: true,
          isPreparation: true,
          updatedAt: true,
        },
        orderBy: { name: 'asc' },
        take: 50,
      }),
      this.prisma.area.findMany({
        where: { tenantId: id, deletedAt: null },
        select: {
          id: true,
          branchId: true,
          name: true,
          emoji: true,
          _count: { select: { tables: true } },
        },
        orderBy: { name: 'asc' },
        take: 50,
      }),
      this.prisma.restaurantTable.findMany({
        where: { tenantId: id, deletedAt: null },
        select: {
          id: true,
          branchId: true,
          areaId: true,
          code: true,
          seats: true,
          status: true,
        },
        orderBy: [{ branchId: 'asc' }, { code: 'asc' }],
        take: 50,
      }),
      this.prisma.order.findMany({
        where: { tenantId: id },
        select: {
          id: true,
          branchId: true,
          tableId: true,
          status: true,
          totalCOP: true,
          createdAt: true,
          closedAt: true,
          table: { select: { code: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
      this.resolveTenantOperationCounts(id),
    ]);

    return {
      counts,
      branches: branches.map((branch) => ({
        id: branch.id,
        name: branch.name,
        address: branch.address ?? undefined,
        phone: branch.phone ?? undefined,
        createdAt: branch.createdAt.toISOString(),
        usersCount: branch._count.userBranches,
        productsCount: branch._count.products,
        ingredientsCount: branch._count.ingredients,
        tablesCount: branch._count.tables,
        ordersCount: branch._count.orders,
      })),
      users: users.map((user) => this.toTenantUserDto(user)),
      productCategories: productCategories.map((category) => ({
        id: category.id,
        branchId: category.branchId ?? undefined,
        name: category.name,
        emoji: category.emoji ?? undefined,
        sortOrder: category.sortOrder,
        productsCount: category._count.products,
      })),
      products: products.map((product) => ({
        id: product.id,
        branchId: product.branchId ?? undefined,
        categoryId: product.categoryId,
        categoryName: product.category?.name,
        name: product.name,
        priceCOP: product.priceCOP,
        emoji: product.emoji ?? undefined,
        isAvailable: product.isAvailable,
        sortOrder: product.sortOrder,
        createdAt: product.createdAt.toISOString(),
        updatedAt: product.updatedAt.toISOString(),
      })),
      ingredients: ingredients.map((ingredient) => ({
        id: ingredient.id,
        branchId: ingredient.branchId,
        categoryId: ingredient.categoryId,
        name: ingredient.name,
        unit: ingredient.recipeUnit,
        currentStock: ingredient.currentStock,
        minStock: ingredient.minStock,
        costPerUnit: ingredient.netUnitCost,
        stockValueCOP: Math.round(
          ingredient.currentStock * ingredient.netUnitCost,
        ),
        isPreparation: ingredient.isPreparation,
        updatedAt: ingredient.updatedAt.toISOString(),
      })),
      areas: areas.map((area) => ({
        id: area.id,
        branchId: area.branchId,
        name: area.name,
        emoji: area.emoji ?? undefined,
        tablesCount: area._count.tables,
      })),
      tables: tables.map((table) => ({
        id: table.id,
        branchId: table.branchId,
        areaId: table.areaId ?? undefined,
        code: table.code,
        seats: table.seats,
        status: table.status,
      })),
      recentOrders: recentOrders.map((order) => ({
        id: order.id,
        branchId: order.branchId,
        tableId: order.tableId,
        tableCode: order.table.code,
        status: order.status,
        totalCOP: order.totalCOP ?? 0,
        itemsCount: order._count.items,
        createdAt: order.createdAt.toISOString(),
        closedAt: order.closedAt?.toISOString(),
      })),
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
    const tenant = await this.loadTenant(tenantId);
    const sub = await this.prisma.subscription.findUnique({
      where: { tenantId },
    });
    if (sub) return this.toSubscriptionDto(sub);

    // Backfill: los tenants creados por signup/admin antes de esta corrección no
    // tenían fila de suscripción, así que el backoffice los mostraba "sin
    // suscripción" aunque ya hubieran pagado. La creamos aquí (derivada del
    // último pago si existe) para que la vista sea consistente con Pagos.
    const created = await this.prisma.$transaction((tx) =>
      this.ensureSubscription(tx, tenantId, tenant.plan),
    );
    return this.toSubscriptionDto(created);
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
      // El precio vigente (priceCOP/priceUSD) es siempre el pactado: si llega
      // agreedPrice manda ese; si no, el alias legacy priceCOP.
      const agreedCOP = dto.agreedPriceCOP ?? dto.priceCOP;
      const agreedUSD = dto.agreedPriceUSD ?? dto.priceUSD;
      const s = await tx.subscription.update({
        where: { tenantId },
        data: {
          plan: dto.plan,
          billingCycle: dto.billingCycle,
          // El formulario manda 'YYYY-MM-DD'. `new Date('2026-08-10')` se parsea
          // como UTC por spec y en Colombia cae el 9 a las 19:00, así que el
          // vencimiento quedaba un día antes de lo que el admin escribió. Se
          // guarda como FIN de ese día en hora Colombia: el cliente tiene todo
          // el día para pagar.
          currentPeriodEnd: dto.currentPeriodEnd
            ? dayEndCO(dto.currentPeriodEnd)
            : undefined,
          nextPaymentDueAt: dto.nextPaymentDueAt
            ? dayEndCO(dto.nextPaymentDueAt)
            : dto.currentPeriodEnd
              ? dayEndCO(dto.currentPeriodEnd)
              : undefined,
          graceEndsAt: dto.currentPeriodEnd
            ? this.addDays(dayEndCO(dto.currentPeriodEnd), GRACE_DAYS)
            : undefined,
          priceCOP: agreedCOP,
          priceUSD: agreedUSD,
          listPriceCOP: dto.listPriceCOP,
          listPriceUSD: dto.listPriceUSD,
          agreedPriceCOP: agreedCOP,
          agreedPriceUSD: agreedUSD,
          discountReason: dto.discountReason,
          discountApprovedBy: dto.discountApprovedBy,
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
    // Los periodos llegan del formulario como 'YYYY-MM-DD'. `new Date()` los
    // parsea como UTC y en Colombia caen el día anterior a las 19:00, así que
    // el periodo cubierto se corría un día. Se anclan al día colombiano: el
    // inicio al comienzo del día, el fin al final.
    const periodStart = dayStartCO(dto.periodStart);
    const periodEnd = dayEndCO(dto.periodEnd);
    const extend = dto.extendPeriod ?? true;

    const kind = dto.kind ?? 'payment';
    // Un bono/cortesía no es plata que entró: se registra para dejar rastro del
    // periodo regalado y del motivo, pero NO suma a ingresos ni a la utilidad.
    const countsAsRevenue = kind === 'payment';
    const currency = dto.currency ?? 'COP';

    const payment = await this.prisma.$transaction(async (tx) => {
      // Un pago siempre debe quedar colgado de una suscripción: si el tenant no
      // tenía (signup no la creaba), la creamos antes de registrar el cobro.
      const subscription = await this.ensureSubscription(
        tx,
        tenantId,
        tenant.plan,
      );

      // Snapshot comercial: precio de lista al momento del cobro y cuánto se
      // dejó de cobrar. Si no vienen en el DTO se derivan de la suscripción.
      const listPrice =
        dto.officialPrice ??
        (currency === 'USD'
          ? (subscription.listPriceUSD ?? subscription.priceUSD)
          : (subscription.listPriceCOP ?? subscription.priceCOP)) ??
        undefined;
      const officialPrice = listPrice ?? dto.amount;
      const discountApplied =
        dto.discountApplied ?? Math.max(0, officialPrice - dto.amount);

      const created = await tx.subscriptionPayment.create({
        data: {
          tenantId,
          subscriptionId: subscription.id,
          plan: tenant.plan,
          kind,
          countsAsRevenue,
          amount: dto.amount,
          officialPrice,
          discountApplied,
          discountReason:
            dto.discountReason ?? subscription.discountReason ?? undefined,
          currency,
          billingCycle:
            dto.billingCycle ?? subscription.billingCycle ?? 'monthly',
          periodStart,
          periodEnd,
          paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
          method: dto.method ?? 'manual',
          reference: dto.reference,
          receiptUrl: dto.receiptUrl,
          note: dto.note,
          extendsPeriod: extend,
          createdByUserId: actorUserId,
        },
      });

      // Pago registrado → opcionalmente extiende el periodo y reactiva la cuenta.
      // Aplica también a bonos: un mes de cortesía corre el vencimiento igual.
      if (extend) {
        await tx.subscription.update({
          where: { tenantId },
          data: {
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            nextPaymentDueAt: periodEnd,
            graceEndsAt: this.addDays(periodEnd, GRACE_DAYS),
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

  // ─── Contactos de cobro ───────────────────────────────────────────────────────

  async listBillingContacts(tenantId: string) {
    await this.loadTenant(tenantId);
    const contacts = await this.prisma.billingContact.findMany({
      where: { tenantId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    return { contacts: contacts.map((c) => this.toBillingContactDto(c)) };
  }

  async createBillingContact(
    tenantId: string,
    dto: UpsertBillingContactDto,
    actorUserId: string,
  ) {
    await this.loadTenant(tenantId);
    // Primer contacto del tenant → primario por defecto.
    const existing = await this.prisma.billingContact.count({
      where: { tenantId },
    });
    const isPrimary = dto.isPrimary ?? existing === 0;

    const contact = await this.prisma.$transaction(async (tx) => {
      if (isPrimary) {
        await tx.billingContact.updateMany({
          where: { tenantId, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      return tx.billingContact.create({
        data: {
          tenantId,
          name: dto.name,
          role: dto.role,
          phone: dto.phone,
          whatsapp: dto.whatsapp,
          email: dto.email,
          isPrimary,
          notes: dto.notes,
        },
      });
    });

    await this.audit(
      actorUserId,
      'billing-contact.create',
      'billing-contact',
      contact.id,
      null,
      this.toBillingContactDto(contact),
    );
    return this.toBillingContactDto(contact);
  }

  async updateBillingContact(
    tenantId: string,
    contactId: string,
    dto: UpdateBillingContactDto,
    actorUserId: string,
  ) {
    const before = await this.prisma.billingContact.findFirst({
      where: { id: contactId, tenantId },
    });
    if (!before) {
      throw new NotFoundException(`Billing contact ${contactId} not found`);
    }

    const contact = await this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary === true) {
        await tx.billingContact.updateMany({
          where: { tenantId, isPrimary: true, id: { not: contactId } },
          data: { isPrimary: false },
        });
      }
      return tx.billingContact.update({
        where: { id: contactId },
        data: {
          name: dto.name,
          role: dto.role,
          phone: dto.phone,
          whatsapp: dto.whatsapp,
          email: dto.email,
          isPrimary: dto.isPrimary,
          notes: dto.notes,
        },
      });
    });

    await this.audit(
      actorUserId,
      'billing-contact.update',
      'billing-contact',
      contact.id,
      this.toBillingContactDto(before),
      this.toBillingContactDto(contact),
    );
    return this.toBillingContactDto(contact);
  }

  async deleteBillingContact(
    tenantId: string,
    contactId: string,
    actorUserId: string,
  ) {
    const before = await this.prisma.billingContact.findFirst({
      where: { id: contactId, tenantId },
    });
    if (!before) {
      throw new NotFoundException(`Billing contact ${contactId} not found`);
    }
    await this.prisma.billingContact.delete({ where: { id: contactId } });
    await this.audit(
      actorUserId,
      'billing-contact.delete',
      'billing-contact',
      contactId,
      this.toBillingContactDto(before),
      null,
    );
    return { ok: true };
  }

  private toBillingContactDto(
    c: Prisma.BillingContactGetPayload<Record<string, never>>,
  ) {
    return {
      id: c.id,
      tenantId: c.tenantId,
      name: c.name,
      role: c.role ?? undefined,
      phone: c.phone,
      whatsapp: c.whatsapp ?? undefined,
      email: c.email ?? undefined,
      isPrimary: c.isPrimary,
      notes: c.notes ?? undefined,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
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
          where: {
            ...this.monthRange(this.currentMonth()),
            countsAsRevenue: true,
          },
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
    // Antes de calcular nada, materializamos los cobros recurrentes vencidos:
    // así "cuánto llevo gastado" incluye la infra/dominios ya cobrados.
    await this.generateDueRecurringExpenses();

    const inRange = { gte: range.from, lt: range.to };
    // BASE CAJA: un pago suma completo en su paidAt. Solo kind='payment'
    // (countsAsRevenue) es ingreso; bonos y notas crédito quedan por fuera.
    const revenueWhere = {
      paidAt: inRange,
      countsAsRevenue: true,
    } satisfies Prisma.SubscriptionPaymentWhereInput;

    const [
      paymentGroups,
      discountGroups,
      bonusGroups,
      expenseGroups,
      expensesByCategory,
      expensesByKind,
      goals,
      mrr,
      lifetime,
      commitments,
    ] = await Promise.all([
      this.prisma.subscriptionPayment.groupBy({
        by: ['currency'],
        where: revenueWhere,
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.subscriptionPayment.groupBy({
        by: ['currency'],
        where: revenueWhere,
        _sum: { discountApplied: true },
      }),
      this.prisma.subscriptionPayment.groupBy({
        by: ['currency'],
        where: { paidAt: inRange, countsAsRevenue: false },
        _count: true,
        _sum: { discountApplied: true },
      }),
      this.prisma.platformExpense.groupBy({
        by: ['currency'],
        where: { incurredAt: inRange },
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.platformExpense.groupBy({
        by: ['category', 'currency'],
        where: { incurredAt: inRange },
        _sum: { amount: true },
        orderBy: [{ category: 'asc' }, { currency: 'asc' }],
      }),
      this.prisma.platformExpense.groupBy({
        by: ['kind', 'currency'],
        where: { incurredAt: inRange },
        _sum: { amount: true },
      }),
      this.prisma.platformFinanceGoal.findMany({
        where: { periodMonth: range.periodMonth },
        orderBy: { metric: 'asc' },
      }),
      this.calculateMrr(),
      this.calculateLifetimeTotals(),
      this.summarizeCommitments(),
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

    // Ingreso potencial (precio de lista) vs real: la diferencia es lo que se
    // dejó de cobrar por descuentos pactados. No es gasto — no toca la utilidad.
    const discounts = this.sumByCurrency(
      discountGroups.map((row) => ({
        currency: row.currency,
        value: row._sum.discountApplied ?? 0,
      })),
    );
    // Se deriva de la invariante neto + descuento = lista, en vez de sumar
    // officialPrice: los pagos anteriores a este módulo lo tienen en null y
    // sumarlos daría un bruto de 0 con ingreso real positivo.
    const grossRevenue = {
      COP: revenue.COP + discounts.COP,
      USD: revenue.USD + discounts.USD,
    };
    const bonuses = this.sumByCurrency(
      bonusGroups.map((row) => ({
        currency: row.currency,
        value: row._sum.discountApplied ?? 0,
      })),
    );

    return {
      period: range.period,
      periodMonth: range.periodMonth,
      dateFrom: range.from.toISOString(),
      dateTo: range.to.toISOString(),
      basis: 'cash' as const,
      revenue,
      grossRevenue,
      discounts,
      bonuses,
      bonusCount: bonusGroups.reduce((acc, row) => acc + row._count, 0),
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
      expensesByKind: expensesByKind.map((row) => ({
        kind: row.kind,
        amount: row._sum.amount ?? 0,
        currency: row.currency,
      })),
      lifetime,
      commitments,
      goals: goals.map((goal) =>
        this.toPlatformFinanceGoalDto(
          goal,
          actuals[goal.metric as PlatformGoalMetric] ?? 0,
        ),
      ),
    };
  }

  /**
   * Acumulado histórico de Lynko desde el día uno: todo lo que entró (pagos
   * reales) contra todo lo que salió (gastos ya incurridos). Es el número de
   * "cuánto llevo invertido y cuánto llevo facturando".
   */
  private async calculateLifetimeTotals() {
    const [payments, expenses, discounts, firstPayment, firstExpense] =
      await Promise.all([
        this.prisma.subscriptionPayment.groupBy({
          by: ['currency'],
          where: { countsAsRevenue: true },
          _count: true,
          _sum: { amount: true },
        }),
        this.prisma.platformExpense.groupBy({
          by: ['currency'],
          _count: true,
          _sum: { amount: true },
        }),
        this.prisma.subscriptionPayment.groupBy({
          by: ['currency'],
          _sum: { discountApplied: true },
        }),
        this.prisma.subscriptionPayment.findFirst({
          orderBy: { paidAt: 'asc' },
          select: { paidAt: true },
        }),
        this.prisma.platformExpense.findFirst({
          orderBy: { incurredAt: 'asc' },
          select: { incurredAt: true },
        }),
      ]);

    const revenue = this.moneyTotals(payments);
    const expenseTotals = this.moneyTotals(expenses);
    const starts = [firstPayment?.paidAt, firstExpense?.incurredAt].filter(
      (d): d is Date => !!d,
    );

    return {
      revenue,
      expenses: expenseTotals,
      profit: {
        COP: revenue.COP - expenseTotals.COP,
        USD: revenue.USD - expenseTotals.USD,
      },
      discounts: this.sumByCurrency(
        discounts.map((row) => ({
          currency: row.currency,
          value: row._sum.discountApplied ?? 0,
        })),
      ),
      paymentsCount: payments.reduce((acc, row) => acc + row._count, 0),
      expensesCount: expenses.reduce((acc, row) => acc + row._count, 0),
      since: starts.length
        ? new Date(Math.min(...starts.map((d) => d.getTime()))).toISOString()
        : null,
    };
  }

  /**
   * Costo fijo comprometido: qué gastos recurrentes están vigentes, cuánto
   * suman al mes (burn rate) y cuál es el próximo cobro que viene.
   */
  private async summarizeCommitments() {
    const active = await this.prisma.platformRecurringExpense.findMany({
      where: { isActive: true },
      orderBy: { nextChargeAt: 'asc' },
    });

    const monthly: Record<'COP' | 'USD', number> = { COP: 0, USD: 0 };
    for (const item of active) {
      const months = RECURRENCE_MONTHS[item.recurrence] ?? 1;
      const perMonth = Math.round(item.amount / months);
      if (item.currency === 'USD') monthly.USD += perMonth;
      else monthly.COP += perMonth;
    }

    return {
      activeCount: active.length,
      monthlyBurn: monthly,
      // Costo anualizado del compromiso vigente.
      yearlyBurn: { COP: monthly.COP * 12, USD: monthly.USD * 12 },
      upcoming: active.slice(0, 5).map((item) => ({
        id: item.id,
        concept: item.concept,
        vendor: item.vendor ?? undefined,
        category: item.category,
        amount: item.amount,
        currency: item.currency,
        recurrence: item.recurrence,
        nextChargeAt: item.nextChargeAt.toISOString(),
        endsAt: item.endsAt?.toISOString(),
      })),
    };
  }

  private sumByCurrency(rows: Array<{ currency: string; value: number }>) {
    const totals: Record<'COP' | 'USD', number> = { COP: 0, USD: 0 };
    for (const row of rows) {
      if (row.currency === 'USD') totals.USD += row.value;
      else totals.COP += row.value;
    }
    return totals;
  }

  /** Día calendario en hora Colombia (el proceso corre con TZ=America/Bogota). */
  private calendarDayCO(date: Date): string {
    const y = date.getFullYear();
    const m = `${date.getMonth() + 1}`.padStart(2, '0');
    const d = `${date.getDate()}`.padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * Libro de ingresos: cada pago con su fecha, tenant, plan, precio de lista,
   * descuento y neto, más el agregado por día. Es el detalle que respalda el KPI
   * de ingresos del dashboard (base caja: cuenta por paidAt).
   */
  async listPlatformIncome(query: PlatformFinanceQueryDto) {
    const range = this.resolvePlatformFinanceRange(query);
    const payments = await this.prisma.subscriptionPayment.findMany({
      where: { paidAt: { gte: range.from, lt: range.to } },
      include: { tenant: { select: { name: true } } },
      orderBy: { paidAt: 'desc' },
    });

    const byDayMap = new Map<
      string,
      { day: string; COP: number; USD: number; count: number }
    >();
    for (const p of payments) {
      if (!p.countsAsRevenue) continue;
      const day = this.calendarDayCO(p.paidAt);
      const bucket = byDayMap.get(day) ?? { day, COP: 0, USD: 0, count: 0 };
      if (p.currency === 'USD') bucket.USD += p.amount;
      else bucket.COP += p.amount;
      bucket.count += 1;
      byDayMap.set(day, bucket);
    }

    const counted = payments.filter((p) => p.countsAsRevenue);
    const net = this.sumByCurrency(
      counted.map((p) => ({ currency: p.currency, value: p.amount })),
    );
    // Mismo criterio que el dashboard: lista = neto + descuento, para no
    // depender de officialPrice (null en los pagos previos a este módulo).
    const gross = this.sumByCurrency(
      counted.map((p) => ({
        currency: p.currency,
        value: p.officialPrice ?? p.amount + p.discountApplied,
      })),
    );
    const discounts = this.sumByCurrency(
      counted.map((p) => ({ currency: p.currency, value: p.discountApplied })),
    );
    const bonuses = this.sumByCurrency(
      payments
        .filter((p) => !p.countsAsRevenue)
        .map((p) => ({ currency: p.currency, value: p.discountApplied })),
    );

    return {
      period: range.period,
      dateFrom: range.from.toISOString(),
      dateTo: range.to.toISOString(),
      basis: 'cash' as const,
      totals: {
        gross,
        discounts,
        net,
        bonuses,
        count: counted.length,
      },
      byDay: [...byDayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
      entries: payments.map((p) => ({
        ...this.toPaymentDto(p),
        tenantName: p.tenant.name,
      })),
    };
  }

  // ─── Gastos recurrentes (compromisos) ────────────────────────────────────────

  async listRecurringExpenses(includeInactive = false) {
    await this.generateDueRecurringExpenses();
    const items = await this.prisma.platformRecurringExpense.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ isActive: 'desc' }, { nextChargeAt: 'asc' }],
      include: {
        _count: { select: { charges: true } },
        charges: { select: { amount: true, currency: true } },
      },
    });
    return { items: items.map((item) => this.toRecurringExpenseDto(item)) };
  }

  async createRecurringExpense(
    dto: CreateRecurringExpenseDto,
    actorUserId: string,
  ) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (endsAt && endsAt <= startsAt) {
      throw new BadRequestException('endsAt debe ser posterior a startsAt');
    }

    const created = await this.prisma.platformRecurringExpense.create({
      data: {
        category: dto.category,
        concept: dto.concept,
        vendor: dto.vendor,
        amount: dto.amount,
        currency: dto.currency ?? 'COP',
        recurrence: dto.recurrence,
        startsAt,
        endsAt,
        nextChargeAt: startsAt,
        isActive: true,
        autoGenerate: dto.autoGenerate ?? true,
        note: dto.note,
        createdByUserId: actorUserId,
      },
    });

    await this.audit(
      actorUserId,
      'platform.finance.recurring.create',
      'platform_recurring_expense',
      created.id,
      null,
      this.toRecurringExpenseDto(created),
    );

    // Contratar suele implicar pagar el primer ciclo de una.
    if (dto.chargeOnCreate !== false) {
      await this.generateDueRecurringExpenses(created.id);
    }
    return this.getRecurringExpense(created.id);
  }

  async updateRecurringExpense(
    id: string,
    dto: UpdateRecurringExpenseDto,
    actorUserId: string,
  ) {
    const current = await this.prisma.platformRecurringExpense.findUnique({
      where: { id },
    });
    if (!current) {
      throw new NotFoundException(`Recurring expense ${id} not found`);
    }

    const updated = await this.prisma.platformRecurringExpense.update({
      where: { id },
      data: {
        category: dto.category,
        concept: dto.concept,
        vendor: dto.vendor,
        amount: dto.amount,
        currency: dto.currency,
        recurrence: dto.recurrence,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
        nextChargeAt: dto.nextChargeAt ? new Date(dto.nextChargeAt) : undefined,
        isActive: dto.isActive,
        autoGenerate: dto.autoGenerate,
        note: dto.note,
      },
    });

    await this.audit(
      actorUserId,
      'platform.finance.recurring.update',
      'platform_recurring_expense',
      id,
      this.toRecurringExpenseDto(current),
      this.toRecurringExpenseDto(updated),
    );
    return this.getRecurringExpense(id);
  }

  /**
   * Dar de baja un compromiso. Los cobros ya generados NO se borran: son plata
   * que efectivamente salió y deben seguir en el histórico.
   */
  async deleteRecurringExpense(id: string, actorUserId: string) {
    const current = await this.prisma.platformRecurringExpense.findUnique({
      where: { id },
    });
    if (!current) {
      throw new NotFoundException(`Recurring expense ${id} not found`);
    }

    await this.prisma.platformRecurringExpense.update({
      where: { id },
      data: { isActive: false, autoGenerate: false },
    });
    await this.audit(
      actorUserId,
      'platform.finance.recurring.cancel',
      'platform_recurring_expense',
      id,
      this.toRecurringExpenseDto(current),
      { isActive: false },
    );
    return { id, isActive: false };
  }

  private async getRecurringExpense(id: string) {
    const item = await this.prisma.platformRecurringExpense.findUnique({
      where: { id },
      include: {
        _count: { select: { charges: true } },
        charges: { select: { amount: true, currency: true } },
      },
    });
    if (!item) throw new NotFoundException(`Recurring expense ${id} not found`);
    return this.toRecurringExpenseDto(item);
  }

  /**
   * Materializa como PlatformExpense todos los cobros vencidos de los
   * compromisos activos (nextChargeAt <= hoy), avanzando el ciclo hasta
   * ponerse al día. Idempotente: solo genera lo que aún no existe.
   */
  async generateDueRecurringExpenses(onlyId?: string) {
    const now = new Date();
    const due = await this.prisma.platformRecurringExpense.findMany({
      where: {
        ...(onlyId ? { id: onlyId } : { autoGenerate: true }),
        isActive: true,
        nextChargeAt: { lte: now },
      },
    });
    if (due.length === 0) return { generated: 0 };

    let generated = 0;
    for (const item of due) {
      let cursor = item.nextChargeAt;
      let lastCharge = item.lastChargeAt;
      // Tope de seguridad: nunca más de 120 ciclos por corrida (evita un bucle
      // infinito si alguien deja un startsAt muy viejo con recurrencia semanal).
      for (let i = 0; i < 120 && cursor <= now; i += 1) {
        if (item.endsAt && cursor > item.endsAt) break;

        const periodEnd = this.advanceRecurrence(cursor, item.recurrence);
        const chargeDate = cursor;
        const already = await this.prisma.platformExpense.count({
          where: { recurringExpenseId: item.id, incurredAt: chargeDate },
        });
        if (already === 0) {
          await this.prisma.platformExpense.create({
            data: {
              category: item.category,
              concept: item.concept,
              vendor: item.vendor,
              amount: item.amount,
              currency: item.currency,
              kind: 'recurring',
              incurredAt: chargeDate,
              periodStart: chargeDate,
              periodEnd,
              note: item.note,
              recurringExpenseId: item.id,
              createdByUserId: item.createdByUserId,
            },
          });
          generated += 1;
        }
        lastCharge = chargeDate;
        cursor = periodEnd;
      }

      const finished = item.endsAt ? cursor > item.endsAt : false;
      await this.prisma.platformRecurringExpense.update({
        where: { id: item.id },
        data: {
          nextChargeAt: cursor,
          lastChargeAt: lastCharge,
          isActive: !finished,
        },
      });
    }

    return { generated };
  }

  private toRecurringExpenseDto(
    item: Prisma.PlatformRecurringExpenseGetPayload<{
      include?: {
        _count?: { select: { charges: true } };
        charges?: { select: { amount: true; currency: true } };
      };
    }> & {
      _count?: { charges: number };
      charges?: Array<{ amount: number; currency: string }>;
    },
  ) {
    const months = RECURRENCE_MONTHS[item.recurrence] ?? 1;
    const paidToDate = (item.charges ?? []).reduce(
      (acc, charge) => acc + charge.amount,
      0,
    );
    return {
      id: item.id,
      category: item.category,
      concept: item.concept,
      vendor: item.vendor ?? undefined,
      amount: item.amount,
      currency: item.currency,
      recurrence: item.recurrence,
      /** Costo mensualizado, para comparar compromisos de distinto ciclo. */
      monthlyAmount: Math.round(item.amount / months),
      startsAt: item.startsAt.toISOString(),
      endsAt: item.endsAt?.toISOString(),
      nextChargeAt: item.nextChargeAt.toISOString(),
      lastChargeAt: item.lastChargeAt?.toISOString(),
      isActive: item.isActive,
      autoGenerate: item.autoGenerate,
      chargesCount: item._count?.charges ?? 0,
      /** Plata realmente desembolsada por este compromiso hasta hoy. */
      paidToDate,
      note: item.note ?? undefined,
      createdByUserId: item.createdByUserId,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
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
        vendor: dto.vendor,
        amount: dto.amount,
        currency: dto.currency ?? 'COP',
        kind: dto.kind ?? 'one_time',
        incurredAt: new Date(dto.incurredAt),
        periodStart: dto.periodStart ? new Date(dto.periodStart) : undefined,
        periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : undefined,
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
        vendor: dto.vendor,
        amount: dto.amount,
        currency: dto.currency,
        kind: dto.kind,
        incurredAt: dto.incurredAt ? new Date(dto.incurredAt) : undefined,
        periodStart: dto.periodStart ? new Date(dto.periodStart) : undefined,
        periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : undefined,
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

  private async resolveTenantOperationCounts(tenantId: string) {
    const [
      branches,
      users,
      activeUsers,
      productCategories,
      products,
      availableProducts,
      ingredients,
      lowStockIngredients,
      areas,
      tables,
      openOrders,
      closedOrders,
      orders,
    ] = await Promise.all([
      this.prisma.branch.count({ where: { tenantId } }),
      this.prisma.user.count({ where: { tenantId } }),
      this.prisma.user.count({ where: { tenantId, isActive: true } }),
      this.prisma.productCategory.count({ where: { tenantId } }),
      this.prisma.product.count({ where: { tenantId, deletedAt: null } }),
      this.prisma.product.count({
        where: { tenantId, deletedAt: null, isAvailable: true },
      }),
      this.prisma.ingredient.count({ where: { tenantId, isActive: true } }),
      this.prisma.ingredient.count({
        where: {
          tenantId,
          isActive: true,
          currentStock: { lte: this.prisma.ingredient.fields.minStock },
        },
      }),
      this.prisma.area.count({ where: { tenantId, deletedAt: null } }),
      this.prisma.restaurantTable.count({
        where: { tenantId, deletedAt: null },
      }),
      this.prisma.order.count({ where: { tenantId, status: 'OPEN' } }),
      this.prisma.order.count({ where: { tenantId, status: 'CLOSED' } }),
      this.prisma.order.count({ where: { tenantId } }),
    ]);

    return {
      branches,
      users,
      activeUsers,
      productCategories,
      products,
      availableProducts,
      ingredients,
      lowStockIngredients,
      areas,
      tables,
      openOrders,
      closedOrders,
      orders,
    };
  }

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

  private addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  /** Descuento = lista − pactado. undefined si no hay precio de lista. */
  private discountBetween(
    listPrice: number | null | undefined,
    agreedPrice: number | null | undefined,
  ): number | undefined {
    if (listPrice == null) return undefined;
    return Math.max(0, listPrice - (agreedPrice ?? listPrice));
  }

  /** Avanza una fecha un ciclo de recurrencia. */
  private advanceRecurrence(date: Date, recurrence: string): Date {
    const next = new Date(date);
    switch (recurrence) {
      case 'weekly':
        next.setDate(next.getDate() + 7);
        break;
      case 'quarterly':
        next.setMonth(next.getMonth() + 3);
        break;
      case 'yearly':
        next.setFullYear(next.getFullYear() + 1);
        break;
      default:
        next.setMonth(next.getMonth() + 1);
    }
    return next;
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
        // Solo plata real: los bonos/cortesías no mueven la meta de ingresos.
        where: { paidAt: { gte: start, lt: end }, countsAsRevenue: true },
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
    const isUSD = p.currency === 'USD';
    return {
      id: p.id,
      tenantId: p.tenantId,
      subscriptionId: p.subscriptionId ?? undefined,
      plan: p.plan,
      kind: p.kind,
      countsAsRevenue: p.countsAsRevenue,
      amount: p.amount,
      currency: p.currency,
      // El FE lee los montos por moneda (amountCOP/USD, officialPrice…), así que
      // proyectamos el par según la moneda del pago.
      amountCOP: isUSD ? undefined : p.amount,
      amountUSD: isUSD ? p.amount : undefined,
      officialPriceCOP: isUSD ? undefined : (p.officialPrice ?? undefined),
      officialPriceUSD: isUSD ? (p.officialPrice ?? undefined) : undefined,
      discountAppliedCOP: isUSD ? undefined : p.discountApplied,
      discountAppliedUSD: isUSD ? p.discountApplied : undefined,
      netAmountCOP: isUSD ? undefined : p.amount,
      netAmountUSD: isUSD ? p.amount : undefined,
      discountReason: p.discountReason ?? undefined,
      billingCycle: p.billingCycle,
      periodStart: p.periodStart.toISOString(),
      periodEnd: p.periodEnd.toISOString(),
      paidAt: p.paidAt.toISOString(),
      method: p.method,
      reference: p.reference ?? undefined,
      receiptUrl: p.receiptUrl ?? undefined,
      note: p.note ?? undefined,
      extendsPeriod: p.extendsPeriod,
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
      vendor: expense.vendor ?? undefined,
      amount: expense.amount,
      currency: expense.currency,
      kind: expense.kind,
      incurredAt: expense.incurredAt.toISOString(),
      periodStart: expense.periodStart?.toISOString(),
      periodEnd: expense.periodEnd?.toISOString(),
      recurringExpenseId: expense.recurringExpenseId ?? undefined,
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
   * Garantiza que el tenant tenga una suscripción; la crea (manual) si no existe.
   * Permite que el backoffice gestione la suscripción de cualquier tenant
   * (incluidos los creados por signup que nunca tuvieron una).
   *
   * Si el tenant ya tiene pagos registrados, la reconstruye desde el último pago
   * (plan, ciclo, periodo, monto → ACTIVE) en vez de inventar un trial: de lo
   * contrario un tenant que ya pagó aparecería "sin suscripción" o en prueba.
   */
  private async ensureSubscription(
    tx: Prisma.TransactionClient,
    tenantId: string,
    plan: string,
  ) {
    const existing = await tx.subscription.findUnique({ where: { tenantId } });
    if (existing) return existing;

    const lastPayment = await tx.subscriptionPayment.findFirst({
      where: { tenantId },
      orderBy: { periodEnd: 'desc' },
    });

    const now = new Date();
    const fallbackEnd = new Date(now);
    fallbackEnd.setMonth(fallbackEnd.getMonth() + 1);

    return tx.subscription.create({
      data: {
        tenantId,
        plan: lastPayment?.plan ?? plan,
        status: lastPayment ? 'ACTIVE' : 'TRIALING',
        billingCycle: lastPayment?.billingCycle ?? 'monthly',
        currentPeriodStart: lastPayment?.periodStart ?? now,
        currentPeriodEnd: lastPayment?.periodEnd ?? fallbackEnd,
        priceCOP:
          lastPayment && lastPayment.currency === 'COP'
            ? lastPayment.amount
            : undefined,
        priceUSD:
          lastPayment && lastPayment.currency === 'USD'
            ? lastPayment.amount
            : undefined,
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
      // Si nunca se fijaron explícitamente, el vencimiento del periodo es la
      // fecha de pago y la gracia son GRACE_DAYS más.
      nextPaymentDueAt: (
        sub.nextPaymentDueAt ?? sub.currentPeriodEnd
      ).toISOString(),
      graceEndsAt: (
        sub.graceEndsAt ?? this.addDays(sub.currentPeriodEnd, GRACE_DAYS)
      ).toISOString(),
      trialEndsAt: sub.trialEndsAt?.toISOString(),
      canceledAt: sub.canceledAt?.toISOString(),
      priceCOP: sub.priceCOP ?? undefined,
      priceUSD: sub.priceUSD ?? undefined,
      listPriceCOP: sub.listPriceCOP ?? undefined,
      listPriceUSD: sub.listPriceUSD ?? undefined,
      agreedPriceCOP: sub.agreedPriceCOP ?? sub.priceCOP ?? undefined,
      agreedPriceUSD: sub.agreedPriceUSD ?? sub.priceUSD ?? undefined,
      // El descuento es derivado: lista − pactado. Nunca se guarda desalineado.
      discountCOP: this.discountBetween(
        sub.listPriceCOP,
        sub.agreedPriceCOP ?? sub.priceCOP,
      ),
      discountUSD: this.discountBetween(
        sub.listPriceUSD,
        sub.agreedPriceUSD ?? sub.priceUSD,
      ),
      discountReason: sub.discountReason ?? undefined,
      discountApprovedBy: sub.discountApprovedBy ?? undefined,
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

  private async ensurePricingConfig() {
    return this.prisma.platformPricingConfig.upsert({
      where: { id: PLATFORM_PRICING_CONFIG_ID },
      update: {},
      create: {
        id: PLATFORM_PRICING_CONFIG_ID,
        usdToCopRate: DEFAULT_USD_TO_COP_RATE,
      },
    });
  }

  private toPricingConfigDto(
    config: Prisma.PlatformPricingConfigGetPayload<Record<string, never>>,
  ) {
    return {
      id: config.id,
      rate: config.usdToCopRate,
      usdToCopRate: config.usdToCopRate,
      updatedAt: config.updatedAt.toISOString(),
      updatedBy: config.updatedBy ?? undefined,
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
