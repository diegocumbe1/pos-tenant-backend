import { ContractType, PayFrequency } from '@prisma/client';

/**
 * Calendario de pago de la nómina, como días calendario 'YYYY-MM-DD'. Aritmética
 * pura: no depende de la zona horaria del proceso.
 *
 * Los días de pago son del contrato (15 y 31, p. ej.) y son independientes de
 * cuándo arrancó: se puede empezar el 1 y pagar el 15 y el fin de mes. El 31
 * significa "último día del mes": en febrero cae el 28 (o 29), en abril el 30.
 *
 * Solo MONTHLY y BIWEEKLY tienen calendario por días del mes. WEEKLY y DAILY
 * no aparecen en "Por pagar": no hay un día del mes que anclar.
 */
export interface PaySchedule {
  payFrequency: PayFrequency;
  payDays: number[];
  /** Primer día en que corre el contrato. */
  startDay: string;
}

/** Los de siempre cuando el contrato no define los suyos. */
export const DEFAULT_PAY_DAYS: Partial<Record<PayFrequency, number[]>> = {
  MONTHLY: [31],
  BIWEEKLY: [15, 31],
};

export function payDaysOf(
  frequency: PayFrequency,
  payDays: number[] | null | undefined,
): number[] {
  const explicit = [...new Set(payDays ?? [])]
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 31)
    .sort((a, b) => a - b);
  return explicit.length > 0 ? explicit : (DEFAULT_PAY_DAYS[frequency] ?? []);
}

const daysInMonth = (y: number, m: number) =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();

const dayString = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(Math.min(d, daysInMonth(y, m))).padStart(2, '0')}`;

/** Los días de pago de UN mes (ya desde el arranque del contrato), en orden. */
export function payDaysInMonth(
  schedule: PaySchedule,
  period: string, // 'YYYY-MM'
): string[] {
  const [y, m] = period.split('-').map(Number);
  const days = payDaysOf(schedule.payFrequency, schedule.payDays);
  return [...new Set(days.map((d) => dayString(y, m, d)))]
    .filter((day) => day >= schedule.startDay)
    .sort();
}

/** Todas las fechas de pago entre `from` y `to` (inclusive), en orden. */
export function payrollOccurrences(
  schedule: PaySchedule,
  from: string,
  to: string,
): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    const period = `${y}-${String(m).padStart(2, '0')}`;
    for (const day of payDaysInMonth(schedule, period)) {
      if (day >= from && day <= to) out.push(day);
    }
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * Cuántos pagos hechos cubren qué fechas. No se enlaza cada pago con una fecha:
 * los pagos de nómina ya existentes no lo traen. En cada mes, N pagos registrados
 * cubren las primeras N fechas de pago de ese mes. Así lo que ya se pagó antes de
 * existir este calendario queda como pagado y no reaparece como pendiente.
 */
export function unpaidOccurrences(
  schedule: PaySchedule,
  from: string,
  to: string,
  paymentsPerPeriod: Map<string, number>,
): string[] {
  const covered = new Set<string>();
  for (const [period, count] of paymentsPerPeriod) {
    payDaysInMonth(schedule, period)
      .slice(0, count)
      .forEach((day) => covered.add(day));
  }
  return payrollOccurrences(schedule, from, to).filter(
    (day) => !covered.has(day),
  );
}

/** Lo que se espera pagar en UNA fecha de pago. null = no se sabe de antemano. */
export function expectedPerPayDay(profile: {
  contractType: ContractType;
  baseAmount: number;
  defaultBonuses: number | null;
  hourlyRate: number | null;
  expectedHoursPerPeriod: number | null;
}): number | null {
  switch (profile.contractType) {
    case 'FIXED':
      return profile.baseAmount;
    case 'FIXED_PLUS_BONUS':
      return profile.baseAmount + (profile.defaultBonuses ?? 0);
    case 'HOURLY': {
      const value = (profile.hourlyRate ?? 0) * (profile.expectedHoursPerPeriod ?? 0);
      return value > 0 ? value : null;
    }
    default:
      // Comisión: lo variable depende de lo vendido y no se inventa. Con un fijo
      // base, ese fijo es lo mínimo seguro; sin él, no se sabe de antemano.
      return profile.baseAmount > 0 ? profile.baseAmount : null;
  }
}
