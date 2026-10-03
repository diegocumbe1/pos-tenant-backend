import { calendarDayCO } from '../common/date.util';
import type { CashMovement } from './finance.service';

/** Un aporte (o parte de él) que el dueño dijo para qué gasto fue. */
export interface CascadeAllocation {
  movementId: string;
  expenseId: string;
  amountCOP: number;
}

/** Cómo se pagó UN gasto. */
export interface CascadeExpense {
  expenseId: string;
  date: string;
  concept: string;
  category: string;
  amountCOP: number;
  /** Pagado con lo que habían dejado las ventas (reinversión). */
  fromSalesCOP: number;
  /** Pagado con plata del dueño: la vinculada a este gasto y la general. */
  fromOwnerCOP: number;
  /** De eso, lo que el dueño dijo explícitamente que puso para este gasto. */
  linkedCOP: number;
  /** Lo que el dueño declaró que salió de ventas (puede no haber alcanzado). */
  declaredFromSalesCOP: number;
  /** Plata de ventas que había disponible justo antes de este gasto. */
  salesAvailableCOP: number;
  /** Lo que nadie ha explicado todavía. */
  missingCOP: number;
}

/** Un faltante por explicar. Con `expenseId` cuando es de un gasto concreto. */
export interface CascadeSuggestion {
  date: string;
  amountCOP: number;
  expenseId?: string;
  concept?: string;
}

/**
 * La cascada (§5 del plan): se recorre la plata en orden y cada pago se cubre
 *   1. con lo que el dueño VINCULÓ a ese gasto ("puse 379.000 para este pedido"),
 *   2. con lo que el dueño DECLARÓ que salió de ventas (REINVERSIÓN), si esa
 *      plata de ventas existía,
 *   3. con aportes generales (sin vincular),
 *   4. y lo que falte es un faltante que nadie ha explicado (SUGERENCIA).
 *
 * LAS VENTAS NO SE USAN SOLAS. Antes la cascada suponía que todo pago se cubría
 * primero con la plata de ventas disponible, y eso inventaba reinversión: en
 * DC Tech un abono de $70.000 del mismo día "pagó" parte de la primera compra,
 * que en realidad fue toda con préstamo. Que hubiera plata de ventas no dice
 * que se usó para comprar. Por defecto, lo no explicado vino de afuera.
 *
 * Lo vinculado manda sobre la fecha: si el dueño dice que un aporte fue para un
 * gasto, cubre ese gasto aunque lo haya anotado con otra fecha. Por eso la parte
 * vinculada de un aporte NO entra al pozo general — ya tiene dueño.
 *
 * El orden es por DÍA y, dentro del día, primero lo que entra: un aporte del
 * 20/08 cubre los pagos del 20/08 aunque se haya anotado a mediodía y el pago
 * fuera a las 8.
 */
export function runCascade(
  rows: CashMovement[],
  allocations: CascadeAllocation[] = [],
  /** expenseId → cuánto declaró el dueño que salió de ventas. */
  declaredFromSales: Map<string, number> = new Map(),
) {
  const sorted = [...rows].sort((a, b) => {
    const day = calendarDayCO(a.at).localeCompare(calendarDayCO(b.at));
    if (day !== 0) return day;
    if (a.direction !== b.direction) return a.direction === 'IN' ? -1 : 1;
    return a.at.getTime() - b.at.getTime();
  });

  const earmarked = new Map<string, number>();
  const allocatedByMovement = new Map<string, number>();
  for (const a of allocations) {
    earmarked.set(a.expenseId, (earmarked.get(a.expenseId) ?? 0) + a.amountCOP);
    allocatedByMovement.set(
      a.movementId,
      (allocatedByMovement.get(a.movementId) ?? 0) + a.amountCOP,
    );
  }

  let salesPool = 0;
  let capitalPool = 0;
  let salesInCOP = 0;
  let refundsCOP = 0;
  let spentCOP = 0;
  let fromSalesCOP = 0;
  let fromCapitalCOP = 0;
  const expenses: CascadeExpense[] = [];
  const otherShortByDay = new Map<string, number>();

  for (const row of sorted) {
    if (row.direction === 'IN') {
      if (row.origin === 'SALES') {
        salesPool += row.amountCOP;
        salesInCOP += row.amountCOP;
      } else {
        // Solo la parte del aporte que NO se vinculó a un gasto queda libre.
        const linked = row.refId
          ? (allocatedByMovement.get(row.refId) ?? 0)
          : 0;
        capitalPool += Math.max(0, row.amountCOP - linked);
      }
      continue;
    }

    const day = calendarDayCO(row.at);
    let rest = row.amountCOP;

    // 1. Lo vinculado a este gasto.
    let linked = 0;
    if (row.origin === 'EXPENSE' && row.refId) {
      linked = Math.min(earmarked.get(row.refId) ?? 0, rest);
      rest -= linked;
    }
    // 2. Ventas, solo lo DECLARADO. 3. Aportes generales. 4. Faltante.
    const salesAvailable = salesPool;
    const declared =
      row.origin === 'EXPENSE' && row.refId
        ? (declaredFromSales.get(row.refId) ?? 0)
        : // Una devolución o un retiro sí sale de la caja de ventas.
          rest;
    const useSales = Math.min(salesPool, rest, declared);
    salesPool -= useSales;
    rest -= useSales;
    const useCapital = Math.min(capitalPool, rest);
    capitalPool -= useCapital;
    rest -= useCapital;
    const missing = rest;

    if (row.origin === 'SALES') refundsCOP += row.amountCOP;
    if (row.origin === 'EXPENSE') {
      spentCOP += row.amountCOP;
      fromSalesCOP += useSales;
      fromCapitalCOP += linked + useCapital;
      expenses.push({
        expenseId: row.refId ?? '',
        date: day,
        concept: row.label ?? '',
        category: row.category,
        amountCOP: row.amountCOP,
        fromSalesCOP: useSales,
        fromOwnerCOP: linked + useCapital,
        linkedCOP: linked,
        declaredFromSalesCOP: row.refId
          ? (declaredFromSales.get(row.refId) ?? 0)
          : 0,
        salesAvailableCOP: salesAvailable,
        missingCOP: missing,
      });
    } else if (missing > 0) {
      // Una devolución o un retiro sin plata para cubrirlo: no es de un gasto.
      otherShortByDay.set(day, (otherShortByDay.get(day) ?? 0) + missing);
    }
  }

  const suggestions: CascadeSuggestion[] = [
    ...expenses
      .filter((e) => e.missingCOP > 0)
      .map((e) => ({
        date: e.date,
        amountCOP: e.missingCOP,
        expenseId: e.expenseId,
        concept: e.concept,
      })),
    ...[...otherShortByDay.entries()].map(([date, amountCOP]) => ({
      date,
      amountCOP,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  return {
    salesInCOP,
    refundsCOP,
    spentCOP,
    fromSalesCOP,
    fromCapitalCOP,
    expenses,
    suggestions,
  };
}
