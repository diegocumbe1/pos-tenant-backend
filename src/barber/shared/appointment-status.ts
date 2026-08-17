// Estados de cita — `BarberAppointment.status` es un String libre, no un enum.
//
// Por eso conviven variantes con distinta capitalización ('completed',
// 'COMPLETED', 'Completed') según por dónde entró la cita. Mientras no exista la
// migración a enum, este módulo es el único lugar que decide qué cuenta como
// completada. Antes había una lista suelta dentro de FinanceService.

/** Variantes aceptadas de "completada". Se comparan sin distinguir mayúsculas. */
export const COMPLETED_STATUSES = ['completed'] as const;

export function isCompletedStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return COMPLETED_STATUSES.includes(
    status.toLowerCase() as (typeof COMPLETED_STATUSES)[number],
  );
}

/**
 * Variantes literales que hay en la base, para los `where` de Prisma (que no
 * tiene comparación case-insensitive en un `in`). Al migrar a enum, esta lista
 * desaparece y `isCompletedStatus` se vuelve una igualdad.
 */
export const COMPLETED_STATUS_VARIANTS = [
  'completed',
  'COMPLETED',
  'Completed',
];
