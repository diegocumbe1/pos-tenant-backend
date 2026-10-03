import { ExpenseFrequency } from '@prisma/client';
import { addCalendarDaysCO } from '../common/date.util';

/**
 * Las fechas en que vence un gasto recurrente, como días calendario
 * 'YYYY-MM-DD'. Aritmética pura sobre el calendario: no depende de la zona
 * horaria del proceso ni de la hora a la que se consulte.
 *
 * - DAILY / WEEKLY: cada 1 / 7 días desde el ancla.
 * - BIWEEKLY (quincenal): dos veces al mes, como se paga en Colombia. Con ancla
 *   el 5 → el 5 y el 20; con ancla el 15 → el 15 y el 30 (o el último día).
 * - MONTHLY: el mismo día cada mes. Un ancla el 31 cae el 30 en abril y el 28
 *   (o 29) en febrero, y vuelve al 31 en mayo: el día no se "pierde".
 * - ANNUAL: la misma fecha cada año (29 de febrero → 28 en años no bisiestos).
 */
export interface RecurrenceRule {
  frequency: ExpenseFrequency;
  anchorDay: string;
  endsOn?: string | null;
}

/** Tope de seguridad: una plantilla diaria con ancla muy vieja no puede reventar la consulta. */
const MAX_OCCURRENCES = 400;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayString(year: number, month: number, day: number): string {
  const capped = Math.min(day, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(capped).padStart(2, '0')}`;
}

/** Todas las ocurrencias entre `fromDay` y `toDay` (inclusive), en orden. */
export function occurrencesBetween(
  rule: RecurrenceRule,
  fromDay: string,
  toDay: string,
): string[] {
  if (rule.frequency === 'ONE_TIME') return [];
  const start = rule.anchorDay > fromDay ? rule.anchorDay : fromDay;
  const end = rule.endsOn && rule.endsOn < toDay ? rule.endsOn : toDay;
  if (start > end) return [];

  const out: string[] = [];
  const push = (day: string) => {
    if (day >= start && day <= end && day >= rule.anchorDay) out.push(day);
  };

  if (rule.frequency === 'DAILY' || rule.frequency === 'WEEKLY') {
    const step = rule.frequency === 'DAILY' ? 1 : 7;
    // Se salta directo a la primera ocurrencia dentro del rango, sin recorrer
    // todo desde el ancla.
    const gap = Math.max(
      0,
      Math.round(
        (Date.parse(`${start}T12:00:00Z`) -
          Date.parse(`${rule.anchorDay}T12:00:00Z`)) /
          86_400_000,
      ),
    );
    let day = addCalendarDaysCO(rule.anchorDay, Math.ceil(gap / step) * step);
    while (day <= end && out.length < MAX_OCCURRENCES) {
      out.push(day);
      day = addCalendarDaysCO(day, step);
    }
    return out;
  }

  const [anchorYear, anchorMonth, anchorDate] = rule.anchorDay
    .split('-')
    .map(Number);
  const [startYear, startMonth] = start.split('-').map(Number);
  const [endYear, endMonth] = end.split('-').map(Number);

  if (rule.frequency === 'ANNUAL') {
    for (let year = startYear; year <= endYear; year++) {
      push(dayString(year, anchorMonth, anchorDate));
    }
    return out;
  }

  // MONTHLY y BIWEEKLY: se recorren los meses del rango.
  const firstHalf = ((anchorDate - 1) % 15) + 1; // 5 → 5, 20 → 5, 15 → 15, 30 → 15
  // Se arranca en el mes más tardío entre el del ancla y el del rango.
  const startsAtAnchor =
    anchorYear * 12 + anchorMonth > startYear * 12 + startMonth;
  let year = startsAtAnchor ? anchorYear : startYear;
  let month = startsAtAnchor ? anchorMonth : startMonth;

  while (
    (year < endYear || (year === endYear && month <= endMonth)) &&
    out.length < MAX_OCCURRENCES
  ) {
    if (rule.frequency === 'MONTHLY') {
      push(dayString(year, month, anchorDate));
    } else {
      push(dayString(year, month, firstHalf));
      push(dayString(year, month, firstHalf + 15));
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}
