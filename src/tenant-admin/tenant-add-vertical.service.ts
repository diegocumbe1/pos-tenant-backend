import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from '../admin/admin.service';
import { BillingGroupsService } from '../platform/billing-groups/billing-groups.service';
import { PlanPricingService, usdToCop } from '../platform/pricing/plan-pricing.service';
import { quoteBundle } from '../platform/pricing/bundle-quote';
import {
  defaultMenuTheme,
  isMenuSlugReserved,
  slugify,
} from '../auth/helpers/auth-helpers';
import type { TenantContext } from '../auth/types/tenant-context.interface';

const VERTICAL_LABEL: Record<string, string> = {
  restaurant: 'Restaurante',
  barber: 'Agenda y reservas',
  retail: 'Tienda',
};
/** Un combo admite hasta tres negocios (una por vertical). */
const MAX_VERTICALS = 3;

/**
 * "Agregar otra vertical" desde Tu plan: un negocio que ya existe suma otro
 * servicio SIN abrir una cuenta nueva.
 *
 * Cada vertical sigue siendo un negocio propio (ver PLAN_CUENTA_DOS_VERTICALES §3),
 * así que esto crea el negocio nuevo con su sede, su suscripción y sus roles, le
 * da al MISMO dueño acceso con su mismo correo, y los junta en un combo de cobro.
 * Solo el dueño. El negocio nuevo nace en prueba, alineado al vencimiento del actual.
 */
@Injectable()
export class TenantAddVerticalService {
  private readonly logger = new Logger(TenantAddVerticalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminService,
    private readonly groups: BillingGroupsService,
    private readonly pricing: PlanPricingService,
  ) {}

  /**
   * Verticales que el dueño todavía no tiene, con lo que le subiría la cuota.
   *
   * La regla del combo (bundle-quote): la vertical MÁS CARA va a precio completo y
   * las demás llevan el descuento. Por eso agregar una más cara que la actual NO la
   * descuenta a ella: pasa a precio completo y la que ya tenías baja. Se calcula con
   * la misma función pura del cobro, con las verticales actuales + la candidata.
   */
  async options(ctx: TenantContext) {
    this.assertOwner(ctx);
    const { tenant, owned } = await this.loadContext(ctx.tenantId);
    const [verticals, bundle, rate] = await Promise.all([
      this.prisma.businessVertical.findMany({
        where: { isActive: true },
        select: { code: true },
      }),
      this.pricing.getBundleDiscountAt(),
      this.pricing.getRateAt(),
    ]);
    const full = owned.size >= MAX_VERTICALS;
    const toCop = (usd: number) => usdToCop(usd, rate);
    const priceOf = async (code: string) => ({
      verticalCode: code,
      priceUSD: (await this.pricing.getPlanPriceAt(code, tenant.plan)) ?? 0,
      termBps: 0,
    });
    const current = await Promise.all([...owned].map(priceOf));
    const currentQuote = quoteBundle({
      lines: current,
      bundleBps: bundle.additionalBps,
      termMonths: 1,
      usdToCop: toCop,
    });

    const rows = await Promise.all(
      verticals
        .filter((v) => !owned.has(v.code))
        .map(async (v) => {
          const candidate = await priceOf(v.code);
          const priced = candidate.priceUSD > 0;
          const q = quoteBundle({
            lines: [...current, candidate],
            bundleBps: bundle.additionalBps,
            termMonths: 1,
            usdToCop: toCop,
          });
          return {
            code: v.code,
            name: VERTICAL_LABEL[v.code] ?? v.code,
            available: priced && !full,
            /** Cuota mensual de toda la cuenta hoy y con la vertical nueva. */
            currentMonthlyCOP: currentQuote.monthlyCOP,
            newMonthlyCOP: q.monthlyCOP,
            /** Lo que sube la cuota por agregarla. */
            addedMonthlyCOP: q.monthlyCOP - currentQuote.monthlyCOP,
            listMonthlyCOP: q.listMonthlyCOP,
            bundleBps: bundle.additionalBps,
            lines: q.lines.map((l) => ({
              code: l.verticalCode,
              name: VERTICAL_LABEL[l.verticalCode] ?? l.verticalCode,
              listCOP: l.listMonthlyCOP,
              monthlyCOP: l.monthlyCOP,
              bundleBps: l.bundleBps,
              isNew: l.verticalCode === v.code,
            })),
          };
        }),
    );
    return { planCode: tenant.plan, options: rows, full };
  }

  async add(
    ctx: TenantContext,
    input: { vertical: string; businessName?: string },
  ) {
    this.assertOwner(ctx);
    if (ctx.isRoot) {
      throw new ForbiddenException(
        'El super-admin no agrega verticales desde aquí: usa el backoffice.',
      );
    }
    const code = input.vertical.trim().toLowerCase();
    const { tenant, owned, group } = await this.loadContext(ctx.tenantId);
    if (owned.has(code)) {
      throw new ConflictException('Ya tienes un negocio de esa vertical.');
    }
    if (owned.size >= MAX_VERTICALS) {
      throw new BadRequestException('Un combo admite hasta tres negocios.');
    }

    const vertical = await this.prisma.businessVertical.findUnique({
      where: { code },
      include: {
        plans: {
          where: { isActive: true, plan: { code: tenant.plan, isActive: true } },
          include: { plan: true },
        },
      },
    });
    if (!vertical || !vertical.isActive) {
      throw new BadRequestException('Esa vertical no está disponible.');
    }
    const selectedPlan = vertical.plans[0]?.plan;
    if (!selectedPlan) {
      throw new BadRequestException(
        `El plan ${tenant.plan} no está disponible para esa vertical.`,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    const tenantId = `tenant-${crypto.randomUUID().slice(0, 8)}`;
    const branchId = `branch-${crypto.randomUUID().slice(0, 8)}`;
    const businessName =
      input.businessName?.trim() ||
      `${tenant.name} ${VERTICAL_LABEL[code] ?? code}`.slice(0, 120);
    const menuSlug = await this.nextAvailableMenuSlug(slugify(businessName));
    const list = await this.pricing.getListPriceAt(code, selectedPlan.code);
    const priceCOP = list?.priceCOP ?? (selectedPlan.priceCOP || undefined);
    const priceUSD = list?.priceUSD;

    // Alineado al vencimiento del negocio actual: un combo se cobra junto.
    const now = new Date();
    const sub = tenant.subscription;
    const due = sub
      ? sub.status === 'TRIALING' && sub.trialEndsAt
        ? sub.trialEndsAt
        : (sub.nextPaymentDueAt ?? sub.currentPeriodEnd)
      : null;
    const periodEnd = due && due > now ? due : new Date(now.getTime() + 30 * 86_400_000);

    await this.prisma.$transaction(async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          name: businessName,
          plan: selectedPlan.code,
          verticalId: vertical.id,
          planId: selectedPlan.id,
        },
      });
      await tx.branch.create({
        data: { id: branchId, tenantId, name: 'Sucursal Principal' },
      });
      await tx.subscription.create({
        data: {
          tenantId,
          plan: selectedPlan.code,
          status: 'TRIALING',
          billingCycle: 'monthly',
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          trialEndsAt: periodEnd,
          priceCOP,
          priceUSD,
          listPriceCOP: priceCOP,
          listPriceUSD: priceUSD,
          agreedPriceCOP: priceCOP,
          agreedPriceUSD: priceUSD,
          provider: 'manual',
        },
      });
      await tx.menuPublicConfig.create({
        data: {
          tenantId,
          branchId,
          slug: menuSlug,
          isPublished: false,
          showPrices: true,
          showDescription: true,
          showImages: true,
          showUnavailable: false,
          showFeaturedBadge: true,
          showRatings: false,
          showSavedCount: false,
          featuredProductIds: [],
          categoryOrder: [],
          ...defaultMenuTheme(businessName),
        },
      });
    });

    await this.admin.seedSystemRolesForTenant(tenantId);
    const ownerRole = await this.prisma.role.findUniqueOrThrow({
      where: { tenantId_code: { tenantId, code: 'OWNER' } },
      select: { id: true },
    });
    await this.prisma.$transaction([
      this.prisma.userTenantMembership.create({
        data: {
          userId: user.id,
          tenantId,
          roleId: ownerRole.id,
          grantedBy: user.id,
        },
      }),
      this.prisma.userBranch.createMany({
        data: [{ userId: user.id, branchId }],
        skipDuplicates: true,
      }),
    ]);

    // El combo: si ya había uno, se suma; si no, se crea con el actual como principal.
    if (group) {
      await this.groups.addTenant(group.id, tenantId, user.id);
    } else {
      await this.groups.create(
        { tenantIds: [ctx.tenantId, tenantId], primaryTenantId: ctx.tenantId },
        user.id,
      );
    }

    await this.audit(user.id, tenantId, {
      from: ctx.tenantId,
      vertical: code,
      plan: selectedPlan.code,
    });
    this.logger.log(`add-vertical ${ctx.tenantId} -> ${tenantId} (${code})`);

    return {
      ok: true,
      tenant: { id: tenantId, name: businessName, vertical: code },
      branch: { id: branchId },
    };
  }

  private assertOwner(ctx: TenantContext) {
    if (!ctx.isRoot && ctx.roleCode !== 'OWNER') {
      throw new ForbiddenException('Solo el dueño puede agregar una vertical.');
    }
  }

  /** Negocio actual y las verticales que ya tiene la cuenta (él + su combo). */
  private async loadContext(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        subscription: true,
        vertical: { select: { code: true } },
        billingGroup: {
          include: {
            tenants: {
              where: { deletedAt: null },
              select: { vertical: { select: { code: true } } },
            },
          },
        },
      },
    });
    if (!tenant) throw new NotFoundException('Negocio no encontrado');
    const group = tenant.billingGroup?.isActive ? tenant.billingGroup : null;
    const owned = new Set<string>();
    if (tenant.vertical?.code) owned.add(tenant.vertical.code);
    for (const t of group?.tenants ?? []) {
      if (t.vertical?.code) owned.add(t.vertical.code);
    }
    return { tenant, owned, group };
  }

  private async nextAvailableMenuSlug(baseSlug: string): Promise<string> {
    const base = baseSlug || 'menu';
    for (let i = 0; i < 100; i += 1) {
      const slug = i === 0 ? base : `${base}-${i + 1}`;
      if (isMenuSlugReserved(slug)) continue;
      const found = await this.prisma.menuPublicConfig.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (!found) return slug;
    }
    throw new ConflictException('No se pudo generar un enlace de menú libre.');
  }

  private async audit(actorUserId: string, targetId: string, after: object) {
    try {
      await this.prisma.platformAuditLog.create({
        data: {
          actorUserId,
          action: 'tenant.add-vertical',
          targetType: 'tenant',
          targetId,
          after,
        },
      });
    } catch (err) {
      this.logger.warn(`audit add-vertical failed: ${(err as Error).message}`);
    }
  }
}
