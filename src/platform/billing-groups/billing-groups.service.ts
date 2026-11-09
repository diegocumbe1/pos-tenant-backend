import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanPricingService } from '../pricing/plan-pricing.service';
import {
  quoteGroup,
  type GroupQuote,
  type GroupTenantInput,
} from './group-quote';

const TENANT_SELECT = {
  id: true,
  name: true,
  plan: true,
  billingGroupId: true,
  deletedAt: true,
  vertical: { select: { code: true } },
  subscription: {
    select: {
      status: true,
      trialEndsAt: true,
      nextPaymentDueAt: true,
      currentPeriodEnd: true,
      agreedPriceLockedAt: true,
      agreedPriceCOP: true,
      priceCOP: true,
    },
  },
} satisfies Prisma.TenantSelect;

type TenantRow = Prisma.TenantGetPayload<{ select: typeof TENANT_SELECT }>;

/**
 * Combo de verticales: qué negocios se cobran juntos y cuánto vale el cobro.
 *
 * Solo toca negocios con `billingGroupId`. Crear el grupo no cobra nada: el
 * cobro se emite aparte (GroupChargesService) con la cotización de aquí.
 */
@Injectable()
export class BillingGroupsService {
  private readonly logger = new Logger(BillingGroupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PlanPricingService,
  ) {}

  /** Grupo del negocio, o null si se cobra solo (el caso normal). */
  async forTenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { billingGroupId: true },
    });
    if (!tenant?.billingGroupId) return { group: null };
    return { group: await this.get(tenant.billingGroupId) };
  }

  async get(groupId: string) {
    const group = await this.prisma.billingGroup.findFirst({
      where: { id: groupId, isActive: true },
      include: {
        tenants: {
          where: { deletedAt: null },
          select: TENANT_SELECT,
          orderBy: { createdAt: 'asc' },
        },
        charges: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            lines: {
              select: {
                id: true,
                tenantId: true,
                amount: true,
                status: true,
                paymentId: true,
              },
            },
          },
        },
      },
    });
    if (!group) throw new NotFoundException('Combo no encontrado');
    return {
      id: group.id,
      name: group.name,
      primaryTenantId: group.primaryTenantId,
      createdAt: group.createdAt,
      tenants: group.tenants.map((t) => ({
        id: t.id,
        name: t.name,
        plan: t.plan,
        vertical: t.vertical?.code ?? null,
        dueAt: this.dueAt(t),
        lockedPrice: t.subscription?.agreedPriceLockedAt
          ? (t.subscription.agreedPriceCOP ?? t.subscription.priceCOP)
          : null,
      })),
      charges: group.charges,
    };
  }

  async create(
    input: { tenantIds: string[]; primaryTenantId?: string; name?: string },
    actorUserId: string,
  ) {
    const ids = [...new Set(input.tenantIds)];
    if (ids.length < 2)
      throw new BadRequestException('Un combo necesita al menos dos negocios.');
    const tenants = await this.loadTenants(ids);
    for (const t of tenants) {
      if (t.billingGroupId)
        throw new ConflictException(`${t.name} ya está en otro combo.`);
    }
    const primaryTenantId =
      input.primaryTenantId && ids.includes(input.primaryTenantId)
        ? input.primaryTenantId
        : ids[0];
    const name =
      input.name?.trim() ||
      `Combo ${tenants.map((t) => t.name).join(' + ')}`.slice(0, 120);

    const group = await this.prisma.$transaction(async (tx) => {
      const created = await tx.billingGroup.create({
        data: { name, primaryTenantId, createdBy: actorUserId },
      });
      await tx.tenant.updateMany({
        where: { id: { in: ids } },
        data: { billingGroupId: created.id },
      });
      return created;
    });
    await this.audit(actorUserId, 'billing-group.create', group.id, null, {
      tenantIds: ids,
      primaryTenantId,
      name,
    });
    return this.get(group.id);
  }

  async addTenant(groupId: string, tenantId: string, actorUserId: string) {
    await this.get(groupId);
    const [tenant] = await this.loadTenants([tenantId]);
    if (tenant.billingGroupId === groupId) return this.get(groupId);
    if (tenant.billingGroupId)
      throw new ConflictException(`${tenant.name} ya está en otro combo.`);
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { billingGroupId: groupId },
    });
    await this.audit(actorUserId, 'billing-group.add-tenant', groupId, null, {
      tenantId,
    });
    return this.get(groupId);
  }

  /**
   * Saca un negocio del combo. Desde su siguiente cobro vuelve a pagar solo y a
   * precio de lista; lo ya pagado no se recalcula. Si queda uno solo, el combo
   * se disuelve: un grupo de un negocio no tiene sentido.
   */
  async removeTenant(groupId: string, tenantId: string, actorUserId: string) {
    const group = await this.get(groupId);
    if (!group.tenants.some((t) => t.id === tenantId))
      throw new NotFoundException('Ese negocio no está en el combo');
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { billingGroupId: null },
    });
    await this.audit(
      actorUserId,
      'billing-group.remove-tenant',
      groupId,
      { tenantId },
      null,
    );

    const remaining = group.tenants.filter((t) => t.id !== tenantId);
    if (remaining.length < 2) return this.dissolve(groupId, actorUserId);
    if (group.primaryTenantId === tenantId) {
      await this.prisma.billingGroup.update({
        where: { id: groupId },
        data: { primaryTenantId: remaining[0].id },
      });
    }
    return this.get(groupId);
  }

  async setPrimary(groupId: string, tenantId: string, actorUserId: string) {
    const group = await this.get(groupId);
    if (!group.tenants.some((t) => t.id === tenantId))
      throw new BadRequestException('Ese negocio no está en el combo');
    await this.prisma.billingGroup.update({
      where: { id: groupId },
      data: { primaryTenantId: tenantId },
    });
    await this.audit(
      actorUserId,
      'billing-group.primary',
      groupId,
      { primaryTenantId: group.primaryTenantId },
      { primaryTenantId: tenantId },
    );
    return this.get(groupId);
  }

  async dissolve(groupId: string, actorUserId: string) {
    await this.prisma.$transaction([
      this.prisma.tenant.updateMany({
        where: { billingGroupId: groupId },
        data: { billingGroupId: null },
      }),
      this.prisma.billingGroup.update({
        where: { id: groupId },
        data: { isActive: false },
      }),
    ]);
    await this.audit(actorUserId, 'billing-group.dissolve', groupId, null, {
      isActive: false,
    });
    return { group: null, dissolved: true };
  }

  /** Cuánto vale el próximo cobro del combo, con la tarifa vigente a su fecha. */
  async quote(
    groupId: string,
    termMonths: number,
    now = new Date(),
  ): Promise<GroupQuote & { groupId: string; groupName: string }> {
    const group = await this.prisma.billingGroup.findFirst({
      where: { id: groupId, isActive: true },
      include: {
        tenants: { where: { deletedAt: null }, select: TENANT_SELECT },
      },
    });
    if (!group) throw new NotFoundException('Combo no encontrado');

    const primary =
      group.tenants.find((t) => t.id === group.primaryTenantId) ??
      group.tenants[0];
    // La tarifa se pregunta a la fecha en que arranca el periodo, igual que un cobro suelto.
    const at = (primary && this.dueAt(primary)) ?? now;
    const term = Math.max(1, Math.round(termMonths));
    const [rate, bundle] = await Promise.all([
      this.pricing.getRateAt(at),
      this.pricing.getBundleDiscountAt(at),
    ]);

    const tenants: GroupTenantInput[] = await Promise.all(
      group.tenants.map(async (t) => {
        const vertical = t.vertical?.code ?? null;
        const [priceUSD, termBps] = vertical
          ? await Promise.all([
              this.pricing.getPlanPriceAt(vertical, t.plan, at),
              this.pricing.getTermDiscountBpsAt(vertical, t.plan, term, at),
            ])
          : [null, 0];
        return {
          tenantId: t.id,
          name: t.name,
          verticalCode: vertical,
          planCode: t.plan,
          priceUSD,
          termBps,
          lockedMonthlyCOP: t.subscription?.agreedPriceLockedAt
            ? (t.subscription.agreedPriceCOP ?? t.subscription.priceCOP ?? null)
            : null,
          dueAt: this.dueAt(t),
        };
      }),
    );

    const quote = quoteGroup({
      tenants,
      primaryTenantId: group.primaryTenantId,
      termMonths: term,
      bundleBps: bundle.additionalBps,
      rate,
      now,
    });
    return { ...quote, groupId: group.id, groupName: group.name };
  }

  /** Mismo vencimiento que muestra la consola (prueba → fin de prueba). */
  private dueAt(t: TenantRow): Date | null {
    const sub = t.subscription;
    if (!sub) return null;
    if (sub.status === 'TRIALING' && sub.trialEndsAt) return sub.trialEndsAt;
    return sub.nextPaymentDueAt ?? sub.currentPeriodEnd ?? null;
  }

  private async loadTenants(ids: string[]) {
    const tenants = await this.prisma.tenant.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: TENANT_SELECT,
    });
    if (tenants.length !== ids.length)
      throw new NotFoundException('Algún negocio no existe');
    return tenants;
  }

  private async audit(
    actorUserId: string,
    action: string,
    targetId: string,
    before: unknown,
    after: unknown,
  ) {
    try {
      await this.prisma.platformAuditLog.create({
        data: {
          actorUserId,
          action,
          targetType: 'billing_group',
          targetId,
          before: (before ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          after: (after ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(`audit ${action} failed: ${(err as Error).message}`);
    }
  }
}
