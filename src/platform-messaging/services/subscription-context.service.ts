import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  diffCalendarDaysCO,
  formatCOP,
  formatDateCO,
  formatDateLongCO,
} from '../../common/date.util';
import { addDays, GRACE_DAYS } from '../../platform/platform.constants';

const PLAN_LABELS: Record<string, string> = {
  BASIC: 'Básico',
  PRO: 'Pro',
  PREMIUM: 'Premium',
};

const CYCLE_LABELS: Record<string, string> = {
  monthly: 'mensual',
  yearly: 'anual',
};

export interface SubscriptionContext {
  tenantId: string;
  tenantName: string;
  slug: string;
  plan: string;
  planLabel: string;
  cycleLabel: string;
  amountCOP: number;
  dueAt: Date | null;
  suspendsAt: Date | null;
  /** Días CALENDARIO colombianos hasta el vencimiento (negativo = vencido). */
  daysToDue: number | null;
  overdue: boolean;
  lastPaymentAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** Qué datos duros faltan para poder redactar el mensaje. */
  missing: string[];
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Reúne todo lo que un mensaje de cobro necesita saber de una cuenta.
 *
 * Es el ÚNICO lugar donde se calculan los días restantes, y lo hace en días
 * CALENDARIO de Colombia (`diffCalendarDaysCO`), no en ventanas de 24 h: si no,
 * dos clientes contactados el mismo día reciben números distintos según la hora.
 * Ver docs/PLATFORM_MESSAGING_PLAN.md §6 R4.
 */
@Injectable()
export class SubscriptionContextService {
  constructor(private readonly prisma: PrismaService) {}

  async build(
    tenantId: string,
    now = new Date(),
  ): Promise<SubscriptionContext> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { subscription: true },
    });
    if (!tenant)
      throw new NotFoundException(`Tenant no encontrado: ${tenantId}`);

    const sub = tenant.subscription;
    const missing: string[] = [];
    if (!sub) missing.push('la cuenta no tiene suscripción');

    const dueAt = sub?.nextPaymentDueAt ?? sub?.currentPeriodEnd ?? null;
    if (sub && !dueAt)
      missing.push('la suscripción no tiene fecha de vencimiento');

    // Mismos fallbacks que usa el backoffice al serializar la suscripción
    // (platform.service): muchas filas tienen graceEndsAt en null y la consola
    // igual muestra "holgura hasta". Sin esto el mensaje saldría con la fecha de
    // suspensión vacía aunque en pantalla se vea.
    const suspendsAt =
      sub?.graceEndsAt ?? (dueAt ? addDays(dueAt, GRACE_DAYS) : null);
    const amountCOP =
      sub?.agreedPriceCOP ?? sub?.priceCOP ?? sub?.listPriceCOP ?? 0;
    if (sub && amountCOP <= 0) missing.push('la suscripción no tiene precio');

    const lastPayment = await this.prisma.subscriptionPayment.findFirst({
      where: { tenantId, countsAsRevenue: true },
      orderBy: { paidAt: 'desc' },
    });

    const daysToDue = dueAt ? diffCalendarDaysCO(now, dueAt) : null;

    return {
      tenantId,
      tenantName: tenant.name,
      slug: slugify(tenant.name),
      plan: sub?.plan ?? tenant.plan,
      planLabel:
        PLAN_LABELS[sub?.plan ?? tenant.plan] ?? sub?.plan ?? tenant.plan,
      cycleLabel: CYCLE_LABELS[sub?.billingCycle ?? 'monthly'] ?? 'mensual',
      amountCOP,
      dueAt,
      suspendsAt,
      daysToDue,
      overdue: daysToDue !== null && daysToDue < 0,
      lastPaymentAt: lastPayment?.paidAt ?? null,
      periodStart: lastPayment?.periodStart ?? sub?.currentPeriodStart ?? null,
      periodEnd: lastPayment?.periodEnd ?? sub?.currentPeriodEnd ?? null,
      missing,
    };
  }

  /** Valores de las variables de suscripción para el renderer. */
  toVariables(ctx: SubscriptionContext): Record<string, string> {
    const period =
      ctx.periodStart && ctx.periodEnd
        ? `${formatDateCO(ctx.periodStart)} – ${formatDateCO(ctx.periodEnd)}`
        : '';

    return {
      negocio: ctx.tenantName,
      slug: ctx.slug,
      plan: ctx.planLabel,
      ciclo: ctx.cycleLabel,
      valor: ctx.amountCOP > 0 ? formatCOP(ctx.amountCOP) : '',
      fecha_vencimiento: ctx.dueAt ? formatDateCO(ctx.dueAt) : '',
      fecha_vencimiento_larga: ctx.dueAt ? formatDateLongCO(ctx.dueAt) : '',
      dias_para_vencer:
        ctx.daysToDue !== null ? String(Math.max(0, ctx.daysToDue)) : '',
      dias_vencido:
        ctx.daysToDue !== null ? String(Math.max(0, -ctx.daysToDue)) : '',
      fecha_suspension: ctx.suspendsAt ? formatDateCO(ctx.suspendsAt) : '',
      fecha_suspension_larga: ctx.suspendsAt
        ? formatDateLongCO(ctx.suspendsAt)
        : '',
      dias_de_holgura:
        ctx.dueAt && ctx.suspendsAt
          ? String(diffCalendarDaysCO(ctx.dueAt, ctx.suspendsAt))
          : '',
      ultimo_pago: ctx.lastPaymentAt ? formatDateCO(ctx.lastPaymentAt) : '',
      periodo: period,
      url_app: `https://${ctx.slug}.${process.env.PLATFORM_APP_DOMAIN ?? 'uselynko.com'}`,
    };
  }
}
