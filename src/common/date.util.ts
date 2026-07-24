/**
 * Utilidades de fecha para hora Colombia (America/Bogota).
 *
 * El proceso corre con TZ=America/Bogota (ver main.ts), así que el constructor
 * local de Date interpreta las cadenas con componente de hora en hora Colombia.
 * OJO: una cadena date-only 'YYYY-MM-DD' SIEMPRE se parsea como UTC por spec de
 * ECMAScript, sin importar la TZ del proceso. Por eso, para filtrar por rango de
 * día hay que anexarle un componente de hora antes de construir el Date.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

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
