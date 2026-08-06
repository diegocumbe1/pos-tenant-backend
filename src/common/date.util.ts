/**
 * Utilidades de fecha para hora Colombia (America/Bogota).
 *
 * El proceso corre con TZ=America/Bogota (ver main.ts), así que el constructor
 * local de Date interpreta las cadenas con componente de hora en hora Colombia.
 * OJO: una cadena date-only 'YYYY-MM-DD' SIEMPRE se parsea como UTC por spec de
 * ECMAScript, sin importar la TZ del proceso. Por eso, para filtrar por rango de
 * día hay que anexarle un componente de hora antes de construir el Date.
 *
 * Los helpers de FORMATO y de DÍA CALENDARIO no dependen del TZ del proceso:
 * `main.ts` respeta el TZ que traiga el host, así que un contenedor con TZ=UTC
 * movería todo cinco horas en silencio. Por eso pasan `timeZone` explícito.
 * Ver docs/PLATFORM_MESSAGING_PLAN.md §6.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const CO_TZ = 'America/Bogota';
export const CO_LOCALE = 'es-CO';

const MS_PER_DAY = 86_400_000;

/** Inicio de día (00:00:00.000) en hora Colombia para 'YYYY-MM-DD'. */
export function dayStartCO(value: string): Date {
  if (DATE_ONLY.test(value)) return new Date(`${value}T00:00:00.000`);
  return new Date(value);
}

/** Fin de día (23:59:59.999) en hora Colombia para 'YYYY-MM-DD'. */
export function dayEndCO(value: string): Date {
  if (DATE_ONLY.test(value)) return new Date(`${value}T23:59:59.999`);
  return new Date(value);
}

function formatter(options: Intl.DateTimeFormatOptions, locale = CO_LOCALE) {
  return new Intl.DateTimeFormat(locale, { timeZone: CO_TZ, ...options });
}

/**
 * Día calendario colombiano de un instante, como 'YYYY-MM-DD'.
 * Se usa 'en-CA' porque formatea justo en ese orden, sin armar la cadena a mano.
 */
export function calendarDayCO(value: Date | string): string {
  return formatter(
    { year: 'numeric', month: '2-digit', day: '2-digit' },
    'en-CA',
  ).format(new Date(value));
}

/** '10/08/2026' */
export function formatDateCO(value: Date | string): string {
  return formatter({
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value));
}

/** 'lunes 10 de agosto de 2026' */
export function formatDateLongCO(value: Date | string): string {
  return formatter({
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value));
}

/** '10/08/2026, 3:45 p. m.' */
export function formatDateTimeCO(value: Date | string): string {
  return formatter({
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(value));
}

/**
 * Diferencia en días CALENDARIO colombianos entre dos instantes, ignorando la
 * hora. Positivo si `to` es posterior.
 *
 * No usar `ceil(diffMs / 86400000)` para esto: esa cuenta es una ventana móvil
 * de 24 h y da números distintos según la hora del mismo día (a las 08:00 dice
 * 5 y a las 20:00 dice 4). Para un contador en pantalla se tolera; para el
 * texto de un mensaje que el cliente lee y usa para pagar, no.
 */
export function diffCalendarDaysCO(
  from: Date | string,
  to: Date | string,
): number {
  // Se anclan ambos días calendario a mediodía UTC: así ningún redondeo cae en
  // el borde del día y la resta es exacta en días enteros.
  const a = Date.parse(`${calendarDayCO(from)}T12:00:00.000Z`);
  const b = Date.parse(`${calendarDayCO(to)}T12:00:00.000Z`);
  return Math.round((b - a) / MS_PER_DAY);
}

/** Moneda colombiana sin decimales: '$ 92.000'. */
export function formatCOP(amount: number): string {
  return new Intl.NumberFormat(CO_LOCALE, {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(amount);
}
