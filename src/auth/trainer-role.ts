/**
 * Rol Entrenador. Existe solo en gimnasios: se crea en el negocio la primera vez
 * que el dueño le da acceso a un entrenador (BarberStaffService.grantAccess).
 * No se puede asignar desde otra parte ni ampliar: ve sus clases y pasa lista.
 *
 * Pendiente acordado (6-nov-2026): que vea sus pagos recibidos por mes, y nada más.
 */
export const TRAINER_ROLE_CODE = 'TRAINER';
export const TRAINER_ROLE_NAME = 'Entrenador';
export const CLASS_ATTEND_PERMISSION = 'barber:classes:attend';
export const TRAINER_PERMISSIONS = [
  'barber:appointments:read',
  CLASS_ATTEND_PERMISSION,
];
export const TRAINER_DEFAULT_OFFSETS = [60];
