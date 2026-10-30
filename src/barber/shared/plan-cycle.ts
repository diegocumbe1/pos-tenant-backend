// Mes de plan: el cupo de sesiones por mes se cuenta desde el día en que
// arrancó el plan, no por mes calendario. Plan del 26 de octubre: el primer mes
// va del 26-oct al 25-nov, el segundo del 26-nov al 25-dic. Sin fecha de
// inicio, el mes calendario.
//
// Todo en días 'YYYY-MM-DD' (calendario colombiano), sin horas.

/** N meses calendario después. Sin ese día en el mes (31-ene + 1), el último. */
export function addMonthsDay(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

function previousDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** Un período congelado del plan: [start, end], ambos inclusive. */
export type FreezeRange = { start: string; end: string };

function addDay(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

function lengthOf(f: FreezeRange): number {
  return Math.round((Date.parse(`${f.end}T00:00:00Z`) - Date.parse(`${f.start}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * "Tiempo de plan": el calendario sin los días congelados. Congelar 10 días
 * corre 10 días todo lo que viene después (el mes de plan, el cupo). Un día
 * dentro de una congelación cae en el día de plan en que se congeló.
 */
export function toPlanDay(day: string, freezes: FreezeRange[] = []): string {
  let shift = 0;
  for (const f of freezes) {
    if (f.end < day) shift += lengthOf(f);
    else if (f.start <= day) shift += lengthOf({ start: f.start, end: day });
  }
  return addDay(day, -shift);
}

/** El día del calendario que corresponde a un día de plan (inverso de `toPlanDay`). */
export function toCalendarDay(planDay: string, freezes: FreezeRange[] = []): string {
  let day = planDay;
  for (const f of [...freezes].sort((a, b) => a.start.localeCompare(b.start))) {
    if (f.start <= day) day = addDay(day, lengthOf(f));
  }
  return day;
}

/** El mes de plan que contiene `day`: [start, end], ambos inclusive. */
export function planCycle(
  startsOn: string | null,
  day: string,
  freezes: FreezeRange[] = [],
): { start: string; end: string } {
  // Con congelaciones, el mes se calcula en tiempo de plan y se devuelve en
  // fechas del calendario (el mes que tuvo una congelación dura más).
  if (startsOn && freezes.length > 0) {
    const cycle = planCycle(startsOn, toPlanDay(day, freezes));
    return {
      start: toCalendarDay(cycle.start, freezes),
      // El último día del mes: el anterior al primero del siguiente.
      end: addDay(toCalendarDay(addDay(cycle.end, 1), freezes), -1),
    };
  }
  if (!startsOn) {
    const start = `${day.slice(0, 7)}-01`;
    return { start, end: previousDay(addMonthsDay(start, 1)) };
  }
  if (day < startsOn) {
    return { start: startsOn, end: previousDay(addMonthsDay(startsOn, 1)) };
  }
  // Meses enteros transcurridos; se ajusta por si el día del mes no alcanza.
  const [sy, sm] = startsOn.split('-').map(Number);
  const [dy, dm] = day.split('-').map(Number);
  let k = (dy - sy) * 12 + (dm - sm);
  if (addMonthsDay(startsOn, k) > day) k -= 1;
  const start = addMonthsDay(startsOn, k);
  return { start, end: previousDay(addMonthsDay(startsOn, k + 1)) };
}

/** Cuántos de esos días caen en el mes de plan de `day`. */
export function usedInCycle(
  startsOn: string | null,
  day: string,
  days: string[],
  freezes: FreezeRange[] = [],
): { start: string; end: string; used: number } {
  const cycle = planCycle(startsOn, day, freezes);
  return {
    ...cycle,
    used: days.filter((d) => d >= cycle.start && d <= cycle.end).length,
  };
}
