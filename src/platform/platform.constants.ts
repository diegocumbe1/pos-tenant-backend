/**
 * Constantes de suscripción compartidas por el backoffice y la mensajería.
 *
 * Viven aparte porque `platform.service` y `platform-messaging` tienen que
 * calcular la MISMA fecha de suspensión: si cada uno usara su propio número,
 * la ficha del tenant y el mensaje que recibe el cliente dirían días distintos.
 */

/** Días de gracia tras el vencimiento antes de cortar el acceso. */
export const GRACE_DAYS = 5;

/** Suma días calendario a un instante (no cambia la hora del día). */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
