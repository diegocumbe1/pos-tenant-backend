import { quoteBundle } from '../pricing/bundle-quote';
import { roundCop } from '../pricing/plan-pricing.service';

/**
 * Cotización del cobro de un combo. Función pura: recibe lo ya leído de la
 * base y devuelve líneas, totales y avisos. La usan el backoffice (vista
 * previa) y la emisión del cobro, así que lo que se ve es lo que se cobra.
 *
 * Reglas (docs/PLAN_CUENTA_DOS_VERTICALES.md §Fase 3 y §5):
 * - Todos los negocios en el mismo plan y de verticales distintas, o no se
 *   puede cobrar en combo (error, no aviso).
 * - Combo + anticipo con `quoteBundle`, sobre los negocios que siguen la tarifa.
 * - Un negocio con precio fijado a mano conserva ese precio (con anticipo
 *   encima) y no entra al combo: el admin ya decidió su precio.
 * - Fechas: el periodo del grupo arranca en el vencimiento del principal. Un
 *   negocio que vence en otra fecha paga por días hasta el fin del periodo del
 *   grupo, y así queda alineado desde el primer cobro. Si ya está cubierto
 *   (p. ej. pagó un anticipo), no se le cobra en este periodo.
 */

export interface GroupTenantInput {
  tenantId: string;
  name: string;
  verticalCode: string | null;
  planCode: string;
  /** Precio de lista mensual en USD de su vertical/plan a la fecha. */
  priceUSD: number | null;
  /** Descuento por anticipo de su vertical/plan para el término. */
  termBps: number;
  /** Precio mensual fijado a mano (agreedPriceLockedAt), o null si sigue la tarifa. */
  lockedMonthlyCOP: number | null;
  /** Desde cuándo debe (su próximo vencimiento). Null = sin suscripción: arranca con el grupo. */
  dueAt: Date | null;
}

export type GroupIssue = {
  level: 'error' | 'warning';
  code:
    | 'too_few'
    | 'plan_mismatch'
    | 'duplicate_vertical'
    | 'missing_vertical'
    | 'missing_price'
    | 'locked_price'
    | 'already_covered'
    | 'prorated';
  message: string;
  tenantId?: string;
};

export interface GroupLine {
  tenantId: string;
  name: string;
  verticalCode: string;
  /** 0 = el que va a precio completo; null = fuera del combo (precio fijado). */
  position: number | null;
  locked: boolean;
  covered: boolean;
  bundleBps: number;
  termBps: number;
  listMonthlyCOP: number;
  monthlyCOP: number;
  periodStart: Date;
  periodEnd: Date;
  /** Proporción del periodo del grupo que se le cobra (1 = completo). */
  factor: number;
  listAmount: number;
  amount: number;
  discountAmount: number;
  discountReason: string | null;
}

export interface GroupQuote {
  termMonths: number;
  planCode: string | null;
  bundleBps: number;
  periodStart: Date;
  periodEnd: Date;
  lines: GroupLine[];
  listAmount: number;
  amount: number;
  discountAmount: number;
  issues: GroupIssue[];
  /** Hay al menos un error: no se puede emitir. */
  blocked: boolean;
}

const DAY = 86_400_000;

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

const VERTICAL_NAME: Record<string, string> = {
  restaurant: 'Restaurante',
  barber: 'Agenda y reservas',
  retail: 'Tienda',
};

export function quoteGroup(input: {
  tenants: GroupTenantInput[];
  primaryTenantId: string;
  termMonths: number;
  bundleBps: number;
  rate: number;
  now: Date;
}): GroupQuote {
  const term = Math.max(1, Math.round(input.termMonths));
  const issues: GroupIssue[] = [];
  const toCop = (usd: number) => roundCop(usd * input.rate);

  // ─── Validaciones que bloquean ─────────────────────────────────────────────
  if (input.tenants.length < 2) {
    issues.push({
      level: 'error',
      code: 'too_few',
      message: 'Un combo necesita al menos dos negocios.',
    });
  }
  const plans = [...new Set(input.tenants.map((t) => t.planCode))];
  if (plans.length > 1) {
    issues.push({
      level: 'error',
      code: 'plan_mismatch',
      message: `Los negocios están en planes distintos (${input.tenants.map((t) => `${t.name}: ${t.planCode}`).join(', ')}). Pásalos todos al mismo plan.`,
    });
  }
  const seen = new Map<string, string>();
  for (const t of input.tenants) {
    if (!t.verticalCode) {
      issues.push({
        level: 'error',
        code: 'missing_vertical',
        tenantId: t.tenantId,
        message: `${t.name} no tiene vertical asignada.`,
      });
      continue;
    }
    const other = seen.get(t.verticalCode);
    if (other) {
      issues.push({
        level: 'error',
        code: 'duplicate_vertical',
        tenantId: t.tenantId,
        message: `${other} y ${t.name} son de la misma vertical (${VERTICAL_NAME[t.verticalCode] ?? t.verticalCode}). Eso no es combo: usa sedes dentro de un mismo negocio.`,
      });
    }
    seen.set(t.verticalCode, t.name);
    if (t.priceUSD == null && t.lockedMonthlyCOP == null) {
      issues.push({
        level: 'error',
        code: 'missing_price',
        tenantId: t.tenantId,
        message: `No hay tarifa cargada para ${t.name} (${t.verticalCode}/${t.planCode}).`,
      });
    }
  }

  // ─── Periodo del grupo: manda el vencimiento del principal ─────────────────
  const primary =
    input.tenants.find((t) => t.tenantId === input.primaryTenantId) ??
    input.tenants[0];
  const periodStart = primary?.dueAt ?? input.now;
  const periodEnd = addMonths(periodStart, term);
  const span = periodEnd.getTime() - periodStart.getTime();

  // ─── Precio mensual de cada negocio ────────────────────────────────────────
  const tariff = input.tenants.filter(
    (t) => t.lockedMonthlyCOP == null && t.priceUSD != null && t.verticalCode,
  );
  // Solo hay combo con dos o más negocios que siguen la tarifa.
  const bundle =
    tariff.length >= 2
      ? quoteBundle({
          lines: tariff.map((t) => ({
            verticalCode: t.verticalCode!,
            priceUSD: t.priceUSD!,
            termBps: t.termBps,
          })),
          bundleBps: input.bundleBps,
          termMonths: 1,
          usdToCop: toCop,
        })
      : null;

  const lines: GroupLine[] = [];
  for (const t of input.tenants) {
    if (!t.verticalCode) continue;
    const locked = t.lockedMonthlyCOP != null;
    const listMonthlyCOP =
      t.priceUSD != null ? toCop(t.priceUSD) : (t.lockedMonthlyCOP ?? 0);

    let monthlyCOP: number;
    let position: number | null = null;
    let bundleBps = 0;
    if (locked) {
      monthlyCOP = roundCop(
        (t.lockedMonthlyCOP! * (10000 - t.termBps)) / 10000,
      );
      issues.push({
        level: 'warning',
        code: 'locked_price',
        tenantId: t.tenantId,
        message: `${t.name} tiene un precio fijado a mano: conserva ese precio y no recibe el descuento del combo.`,
      });
    } else {
      const fromBundle = bundle?.lines.find(
        (l) => l.verticalCode === t.verticalCode,
      );
      if (fromBundle) {
        monthlyCOP = fromBundle.monthlyCOP;
        position = fromBundle.position;
        bundleBps = fromBundle.bundleBps;
      } else {
        monthlyCOP =
          t.priceUSD != null
            ? toCop((t.priceUSD * (10000 - t.termBps)) / 10000)
            : 0;
      }
    }

    const ownStart = t.dueAt ?? periodStart;
    const covered = ownStart.getTime() >= periodEnd.getTime();
    const factor = covered
      ? 0
      : (periodEnd.getTime() - ownStart.getTime()) / span;
    if (covered) {
      issues.push({
        level: 'warning',
        code: 'already_covered',
        tenantId: t.tenantId,
        message: `${t.name} ya tiene pago hasta ${ownStart.toISOString().slice(0, 10)}: no se le cobra en este periodo y entra al combo en el siguiente.`,
      });
    } else if (Math.abs(ownStart.getTime() - periodStart.getTime()) >= DAY) {
      const days = Math.round((periodEnd.getTime() - ownStart.getTime()) / DAY);
      issues.push({
        level: 'warning',
        code: 'prorated',
        tenantId: t.tenantId,
        message: `${t.name} vence en otra fecha: se le cobran ${days} días para alinearlo con el combo.`,
      });
    }

    const exact = factor === 1;
    const amount = covered
      ? 0
      : exact
        ? monthlyCOP * term
        : roundCop(monthlyCOP * term * factor);
    const listAmount = covered
      ? 0
      : exact
        ? listMonthlyCOP * term
        : roundCop(listMonthlyCOP * term * factor);
    const discountAmount = Math.max(0, listAmount - amount);
    const reasons: string[] = [];
    if (bundleBps > 0)
      reasons.push(
        `combo ${input.tenants.length} verticales −${bundleBps / 100}%`,
      );
    if (t.termBps > 0)
      reasons.push(`anticipo ${term} meses −${t.termBps / 100}%`);
    if (locked) reasons.push('precio fijado');

    lines.push({
      tenantId: t.tenantId,
      name: t.name,
      verticalCode: t.verticalCode,
      position,
      locked,
      covered,
      bundleBps,
      termBps: t.termBps,
      listMonthlyCOP,
      monthlyCOP,
      periodStart: covered ? periodEnd : ownStart,
      periodEnd,
      factor: Math.round(factor * 10000) / 10000,
      listAmount,
      amount,
      discountAmount,
      discountReason: reasons.length > 0 ? reasons.join(' · ') : null,
    });
  }

  // El principal arriba y luego por posición en el combo.
  lines.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));

  const amount = lines.reduce((s, l) => s + l.amount, 0);
  const listAmount = lines.reduce((s, l) => s + l.listAmount, 0);
  const blocked = issues.some((i) => i.level === 'error') || amount <= 0;

  return {
    termMonths: term,
    planCode: plans.length === 1 ? plans[0] : null,
    bundleBps: input.bundleBps,
    periodStart,
    periodEnd,
    lines,
    listAmount,
    amount,
    discountAmount: Math.max(0, listAmount - amount),
    issues,
    blocked,
  };
}
