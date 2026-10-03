import { ExpenseNature } from '@prisma/client';

/**
 * Naturaleza por defecto de cada categoría de gasto.
 *
 * El gasto guarda `nature` NULL cuando el dueño no la cambió, y se resuelve
 * aquí al leer. Así los gastos viejos no necesitan backfill y, si cambia el
 * criterio de una categoría, el histórico se lee con el criterio nuevo sin
 * reescribir filas.
 *
 * FIJO = se paga igual haya ventas o no. VARIABLE = se mueve con las ventas.
 * OCASIONAL = sin patrón.
 */
const NATURE_BY_CATEGORY: Record<string, ExpenseNature> = {
  PAYROLL: 'FIXED',
  OWNER_SALARY: 'FIXED',
  RENT: 'FIXED',
  PLATFORM: 'FIXED',
  UTILITIES: 'FIXED',
  KITCHEN: 'VARIABLE',
  INVENTORY_PURCHASE: 'VARIABLE',
  INVENTORY_SHIPPING: 'VARIABLE',
  SALES_SHIPPING: 'VARIABLE',
  FINANCING_FEE: 'VARIABLE',
  OPERATIONS: 'VARIABLE',
  PETTY_CASH: 'VARIABLE',
  MAINTENANCE: 'OCCASIONAL',
  EXTRAORDINARY: 'OCCASIONAL',
  TAXES: 'OCCASIONAL',
  OTHER: 'OCCASIONAL',
};

export function defaultNatureFor(category: string): ExpenseNature {
  return NATURE_BY_CATEGORY[category?.toUpperCase()] ?? 'OCCASIONAL';
}

/** La naturaleza efectiva: la elegida, o la de su categoría. */
export function resolveNature(
  category: string,
  nature: ExpenseNature | null | undefined,
): ExpenseNature {
  return nature ?? defaultNatureFor(category);
}
