/**
 * Utilidades de fecha para hora Colombia (America/Bogota).
 *
 * NINGÚN helper de este archivo depende de la TZ del proceso. `main.ts` respeta
 * el TZ que traiga el host (`process.env.TZ ?? 'America/Bogota'`), así que un
 * contenedor arrancado con TZ=UTC movería todo cinco horas en silencio: los
 * bordes de día anclan el offset a mano y los de formato pasan `timeZone`.
 * Ver docs/PLATFORM_MESSAGING_PLAN.md §6.
 *
 * OJO: una cadena date-only 'YYYY-MM-DD' SIEMPRE se parsea como UTC por spec de
 * ECMAScript. Por eso, para filtrar por rango de día hay que anexarle hora Y
 * offset antes de construir el Date.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const CO_TZ = 'America/Bogota';
export const CO_LOCALE = 'es-CO';

/**
 * Colombia no tiene horario de verano y lleva en UTC-5 de forma permanente, así
 * que fijar el offset es seguro y hace los bordes de día reproducibles en
 * cualquier host. Espejo de `CO_UTC_OFFSET` en el frontend (lib/date.ts).
 */
export const CO_UTC_OFFSET = '-05:00';

const MS_PER_DAY = 86_400_000;

/** Inicio de día (00:00:00.000) en hora Colombia para 'YYYY-MM-DD'. */
export function dayStartCO(value: string): Date {
  if (DATE_ONLY.test(value))
    return new Date(`${value}T00:00:00.000${CO_UTC_OFFSET}`);
  return new Date(value);
}

/** Fin de día (23:59:59.999) en hora Colombia para 'YYYY-MM-DD'. */
export function dayEndCO(value: string): Date {
  if (DATE_ONLY.test(value))
    return new Date(`${value}T23:59:59.999${CO_UTC_OFFSET}`);
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
 * Hora del reloj colombiano de un instante, como 'HH:mm:ss' de 24 horas.
 *
 * Sirve para anclar un día suelto ('2026-09-03') a una hora concreta: una
 * cadena date-only se parsea como UTC por spec, así que sin hora ni offset el
 * "3 de septiembre" colombiano cae en el 2 a las 7 de la noche.
 */
export function clockTimeCO(value: Date | string = new Date()): string {
  // `hourCycle: 'h23'` y no `hour12: false`: con hour12 el ciclo lo elige el
  // locale y varios resuelven a h24, que escribe la medianoche como '24:30:00'.
  // Esa cadena no es una hora válida en un ISO y correría la fecha un día.
  return formatter(
    {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    },
    'en-GB',
  ).format(new Date(value));
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

/**
 * Suma n días a una fecha calendario 'YYYY-MM-DD' y devuelve 'YYYY-MM-DD'.
 * Aritmética pura anclada en UTC: no toca la TZ del proceso.
 */
export function addCalendarDaysCO(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Mes calendario colombiano de un instante, como 'YYYY-MM'. */
export function calendarMonthCO(value: Date | string = new Date()): string {
  return calendarDayCO(value).slice(0, 7);
}

/** Primer día ('YYYY-MM-DD') del mes calendario colombiano de un instante. */
export function monthStartDayCO(value: Date | string = new Date()): string {
  return `${calendarMonthCO(value)}-01`;
}

/** Último día ('YYYY-MM-DD') del mes calendario colombiano de un instante. */
export function monthEndDayCO(value: Date | string = new Date()): string {
  const [year, month] = calendarMonthCO(value).split('-').map(Number);
  // Día 0 del mes siguiente = último día del mes en curso.
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** Lunes ('YYYY-MM-DD') de la semana colombiana de un instante. */
export function weekStartDayCO(value: Date | string = new Date()): string {
  const day = calendarDayCO(value);
  const weekday = new Date(`${day}T12:00:00.000Z`).getUTCDay(); // 0 = domingo
  return addCalendarDaysCO(day, -(weekday === 0 ? 6 : weekday - 1));
}

/** Moneda colombiana sin decimales: '$ 92.000'. */
export function formatCOP(amount: number): string {
  return new Intl.NumberFormat(CO_LOCALE, {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(amount);
}
