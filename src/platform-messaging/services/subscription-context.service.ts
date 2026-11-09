import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  diffCalendarDaysCO,
  formatCOP,
  formatDateCO,
  formatDateLongCO,
} from '../../common/date.util';
import { addDays, GRACE_DAYS } from '../../platform/platform.constants';
import { subscriptionPriceAt } from '../../platform/pricing/subscription-price';
import { BillingGroupsService } from '../../platform/billing-groups/billing-groups.service';

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
  /**
   * Solo si el negocio está en un combo: el próximo cobro del combo, línea por
   * línea. Con esto `valor` es el total del combo y `detalle_plan` el desglose.
   */
  combo: ComboContext | null;
}

export interface ComboContext {
  name: string;
  planLabel: string;
  lines: Array<{
    tenantName: string;
    verticalCode: string;
    amount: number;
    listAmount: number;
    bundleBps: number;
    position: number | null;
    locked: boolean;
    covered: boolean;
  }>;
  amount: number;
  listAmount: number;
  discountAmount: number;
}

const VERTICAL_LINE: Record<string, string> = {
  restaurant: '🍽️ Restaurante',
  barber: '📅 Agenda y reservas',
  retail: '🛍️ Tienda',
};

/**
 * Desglose del combo para WhatsApp y correo (el correo convierte *negrita*).
 * Sin tachado (~): el correo no lo convierte y se vería el símbolo. Empieza
 * con salto de línea para ir pegado a la línea del valor; vacío sin combo.
 */
export function renderComboDetail(combo: ComboContext | null): string {
  if (!combo) return '';
  const rows = combo.lines
    .filter((l) => !l.covered)
    .map((l) => {
      const head = `${VERTICAL_LINE[l.verticalCode] ?? l.verticalCode} · ${l.tenantName}: ${formatCOP(l.amount)}`;
      if (l.locked) return `${head} (precio acordado)`;
      if (l.bundleBps > 0 && l.listAmount > l.amount) {
        return `${head} (−${l.bundleBps / 100}% combo, antes ${formatCOP(l.listAmount)})`;
      }
      return l.position === 0 ? `${head} (precio completo)` : head;
    });
  const saving =
    combo.discountAmount > 0
      ? `\n💰 Ahorras ${formatCOP(combo.discountAmount)} frente a pagarlos por separado`
      : '';
  return `\n\n*${combo.planLabel} · ${rows.length} negocios*\n${rows.join('\n')}${saving}`;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly groups: BillingGroupsService,
  ) {}

  async build(
    tenantId: string,
    now = new Date(),
  ): Promise<SubscriptionContext> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { subscription: true, vertical: { select: { code: true } } },
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
    // El monto del cobro que viene: la tarifa de la fecha de pago, o el precio
    // que fijó el admin. Igual que el link de pago (ChargesService.quote).
    const priced = sub
      ? await subscriptionPriceAt(this.prisma, {
          verticalCode: tenant.vertical?.code,
          planCode: sub.plan,
          subscription: sub,
          at: dueAt ?? now,
        })
      : null;
    // La tarifa es mensual; un precio fijado ya está guardado por ciclo.
    const pricedCOP =
      priced &&
      !priced.locked &&
      priced.priceCOP != null &&
      sub?.billingCycle === 'yearly'
        ? priced.priceCOP * 12
        : priced?.priceCOP;
    const amountCOP =
      pricedCOP ??
      sub?.agreedPriceCOP ??
      sub?.priceCOP ??
      sub?.listPriceCOP ??
      0;
    if (sub && amountCOP <= 0) missing.push('la suscripción no tiene precio');

    const lastPayment = await this.prisma.subscriptionPayment.findFirst({
      where: { tenantId, countsAsRevenue: true },
      orderBy: { paidAt: 'desc' },
    });

    const daysToDue = dueAt ? diffCalendarDaysCO(now, dueAt) : null;

    // Combo: el valor a pagar es el del combo y el mensaje lleva el desglose.
    // Si la cotización falla (p. ej. planes distintos), se manda como negocio
    // solo y se marca para que el admin lo vea antes de enviar.
    let combo: ComboContext | null = null;
    if (tenant.billingGroupId) {
      try {
        const q = await this.groups.quote(tenant.billingGroupId, 1, now);
        const planLabel =
          `Combo ${PLAN_LABELS[q.planCode ?? ''] ?? q.planCode ?? ''}`.trim();
        combo = {
          name: q.groupName,
          planLabel,
          lines: q.lines.map((l) => ({
            tenantName: l.name,
            verticalCode: l.verticalCode,
            amount: l.amount,
            listAmount: l.listAmount,
            bundleBps: l.bundleBps,
            position: l.position,
            locked: l.locked,
            covered: l.covered,
          })),
          amount: q.amount,
          listAmount: q.listAmount,
          discountAmount: q.discountAmount,
        };
        if (q.blocked) {
          missing.push(
            `el combo no se puede cobrar: ${q.issues
              .filter((i) => i.level === 'error')
              .map((i) => i.message)
              .join(' ')}`,
          );
        }
      } catch (err) {
        missing.push(
          `no se pudo calcular el combo (${(err as Error).message})`,
        );
      }
    }

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
      combo,
    };
  }

  /** Valores de las variables de suscripción para el renderer. */
  toVariables(ctx: SubscriptionContext): Record<string, string> {
    const period =
      ctx.periodStart && ctx.periodEnd
        ? `${formatDateCO(ctx.periodStart)} – ${formatDateCO(ctx.periodEnd)}`
        : '';

    return {
      // Con combo, el mensaje habla del combo: un valor, un plan, un desglose.
      negocio: ctx.combo
        ? ctx.combo.lines.map((l) => l.tenantName).join(' + ')
        : ctx.tenantName,
      slug: ctx.slug,
      plan: ctx.combo?.planLabel ?? ctx.planLabel,
      detalle_plan: renderComboDetail(ctx.combo),
      ciclo: ctx.cycleLabel,
      valor: ctx.combo
        ? formatCOP(ctx.combo.amount)
        : ctx.amountCOP > 0
          ? formatCOP(ctx.amountCOP)
          : '',
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
