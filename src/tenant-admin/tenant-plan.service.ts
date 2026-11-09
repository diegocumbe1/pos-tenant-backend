import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BillingGroupsService } from '../platform/billing-groups/billing-groups.service';
import { subscriptionPriceAt } from '../platform/pricing/subscription-price';
import { addDays, GRACE_DAYS } from '../platform/platform.constants';
import type { TenantContext } from '../auth/types/tenant-context.interface';

/**
 * "Tu plan" en Ajustes: lo que el dueño paga, cuándo vence y, si está en un
 * combo, cómo quedó cada negocio. Solo lectura y solo para el dueño (y el
 * super-admin en modo soporte): son cifras comerciales, no operativas.
 *
 * Usa las MISMAS reglas que el cobro (subscriptionPriceAt y la cotización del
 * combo), así que lo que el dueño ve aquí es lo que le llega en el link.
 */
@Injectable()
export class TenantPlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly groups: BillingGroupsService,
  ) {}

  async summary(ctx: TenantContext, now = new Date()) {
    if (!ctx.isRoot && ctx.roleCode !== 'OWNER') {
      throw new ForbiddenException('Solo el dueño ve el plan y los pagos.');
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: ctx.tenantId },
      include: { subscription: true, vertical: { select: { code: true } } },
    });
    if (!tenant) throw new NotFoundException('Negocio no encontrado');
    const sub = tenant.subscription;

    const isTrial = sub?.status === 'TRIALING' && !!sub.trialEndsAt;
    const dueAt = sub
      ? isTrial
        ? sub.trialEndsAt
        : (sub.nextPaymentDueAt ?? sub.currentPeriodEnd)
      : null;
    const graceEndsAt =
      sub?.graceEndsAt && dueAt && sub.graceEndsAt > dueAt
        ? sub.graceEndsAt
        : dueAt
          ? addDays(dueAt, GRACE_DAYS)
          : null;

    const price = sub
      ? await subscriptionPriceAt(this.prisma, {
          verticalCode: tenant.vertical?.code,
          planCode: sub.plan,
          subscription: sub,
          at: dueAt ?? now,
        })
      : null;

    const lastPayment = await this.prisma.subscriptionPayment.findFirst({
      where: { tenantId: tenant.id, countsAsRevenue: true },
      orderBy: { paidAt: 'desc' },
      select: {
        paidAt: true,
        amount: true,
        periodStart: true,
        periodEnd: true,
      },
    });

    let combo: null | {
      name: string;
      lines: Array<{
        tenantId: string;
        name: string;
        verticalCode: string;
        amount: number;
        listAmount: number;
        bundleBps: number;
        position: number | null;
        locked: boolean;
        isThis: boolean;
      }>;
      amount: number;
      listAmount: number;
      discountAmount: number;
      bundleBps: number;
    } = null;
    if (tenant.billingGroupId) {
      const q = await this.groups
        .quote(tenant.billingGroupId, 1, now)
        .catch(() => null);
      if (q) {
        combo = {
          name: q.groupName,
          lines: q.lines.map((l) => ({
            tenantId: l.tenantId,
            name: l.name,
            verticalCode: l.verticalCode,
            amount: l.amount,
            listAmount: l.listAmount,
            bundleBps: l.bundleBps,
            position: l.position,
            locked: l.locked,
            isThis: l.tenantId === tenant.id,
          })),
          amount: q.amount,
          listAmount: q.listAmount,
          discountAmount: q.discountAmount,
          bundleBps: q.bundleBps,
        };
      }
    }

    return {
      planCode: sub?.plan ?? tenant.plan,
      vertical: tenant.vertical?.code ?? null,
      status: sub?.status ?? null,
      isTrial,
      dueAt,
      graceEndsAt,
      monthlyCOP: price?.priceCOP ?? null,
      listMonthlyCOP: price?.listCOP ?? null,
      locked: price?.locked ?? false,
      lastPayment,
      combo,
    };
  }
}
