import { calendarDayCO, dayStartCO } from './date.util';

/**
 * Días hábiles de Colombia: lunes a viernes, sin festivos.
 *
 * Los festivos se calculan, no se guardan en una tabla:
 *  - fijos: 1 ene, 1 may, 20 jul, 7 ago, 8 dic, 25 dic;
 *  - "Ley Emiliani" (se pasan al lunes siguiente): 6 ene, 19 mar, 29 jun,
 *    15 ago, 12 oct, 1 nov, 11 nov;
 *  - de Semana Santa: jueves y viernes santo (fijos), y los lunes de Ascensión
 *    (Pascua + 43), Corpus Christi (+64) y Sagrado Corazón (+71);
 *  - Pascua por el algoritmo de Meeus/Jones/Butcher.
 *
 * Todo sobre días calendario 'YYYY-MM-DD': no depende de la zona del servidor.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Día de la semana de un 'YYYY-MM-DD' (0 = domingo). */
function weekday(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Domingo de Pascua (calendario gregoriano). */
function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const dayOfMonth = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, dayOfMonth);
}

/** Si cae en lunes se queda; si no, pasa al lunes siguiente (Ley Emiliani). */
function toNextMonday(day: string): string {
  const wd = weekday(day);
  return wd === 1 ? day : addDays(day, wd === 0 ? 1 : 8 - wd);
}

const cache = new Map<number, Set<string>>();

export function colombianHolidays(year: number): Set<string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const pascua = easter(year);
  const set = new Set<string>([
    ymd(year, 1, 1),
    ymd(year, 5, 1),
    ymd(year, 7, 20),
    ymd(year, 8, 7),
    ymd(year, 12, 8),
    ymd(year, 12, 25),
    toNextMonday(ymd(year, 1, 6)),
    toNextMonday(ymd(year, 3, 19)),
    toNextMonday(ymd(year, 6, 29)),
    toNextMonday(ymd(year, 8, 15)),
    toNextMonday(ymd(year, 10, 12)),
    toNextMonday(ymd(year, 11, 1)),
    toNextMonday(ymd(year, 11, 11)),
    addDays(pascua, -3),
    addDays(pascua, -2),
    addDays(pascua, 43),
    addDays(pascua, 64),
    addDays(pascua, 71),
  ]);
  cache.set(year, set);
  return set;
}

export function isBusinessDayCO(day: string): boolean {
  const wd = weekday(day);
  if (wd === 0 || wd === 6) return false;
  return !colombianHolidays(Number(day.slice(0, 4))).has(day);
}

/**
 * `n` días hábiles después de `fromDay`. Desde un día NO hábil (un sábado), el
 * primer día hábil siguiente cuenta como 1: pagado el sábado 21, "1 día hábil"
 * es el lunes 23. `n = 0` devuelve el mismo día.
 */
export function addBusinessDaysCO(fromDay: string, n: number): string {
  let day = fromDay;
  let remaining = n;
  let guard = 0;
  while (remaining > 0 && guard++ < 400) {
    day = addDays(day, 1);
    if (isBusinessDayCO(day)) remaining -= 1;
  }
  return day;
}

/** Igual, con instantes: devuelve el mediodía de Colombia del día de abono. */
export function addBusinessDaysFromDate(from: Date, n: number): Date {
  const day = addBusinessDaysCO(calendarDayCO(from), n);
  return new Date(dayStartCO(day).getTime() + 12 * 60 * 60 * 1000);
}
