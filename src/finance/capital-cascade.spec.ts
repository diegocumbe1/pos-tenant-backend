import { runCascade } from './capital-cascade';
import type { CashMovement } from './finance.service';

const at = (day: string, hour = 12, minute = 0) =>
  new Date(
    `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-05:00`,
  );
const sale = (
  day: string,
  amountCOP: number,
  hour?: number,
  minute?: number,
): CashMovement => ({
  at: at(day, hour, minute),
  direction: 'IN',
  category: 'SALES',
  origin: 'SALES',
  amountCOP,
});
const expense = (
  day: string,
  amountCOP: number,
  hour?: number,
): CashMovement => ({
  at: at(day, hour),
  direction: 'OUT',
  category: 'INVENTORY_PURCHASE',
  origin: 'EXPENSE',
  amountCOP,
  refId: `exp-${day}-${amountCOP}`,
  label: `Compra ${day}`,
});
const contribution = (
  day: string,
  amountCOP: number,
  hour?: number,
): CashMovement => ({
  at: at(day, hour),
  direction: 'IN',
  category: 'CAPITAL_CONTRIBUTION',
  origin: 'CAPITAL',
  amountCOP,
  refId: `cap-${day}-${amountCOP}`,
});
const withdrawal = (day: string, amountCOP: number): CashMovement => ({
  at: at(day),
  direction: 'OUT',
  category: 'OWNER_WITHDRAWAL',
  origin: 'CAPITAL',
  amountCOP,
  refId: `wd-${day}-${amountCOP}`,
});

describe('runCascade', () => {
  it('sin ventas todo sale de afuera y se sugiere como aporte', () => {
    const result = runCascade([expense('2026-07-29', 348_000)]);
    expect(result.fromSalesCOP).toBe(0);
    expect(result.suggestions).toEqual([
      {
        date: '2026-07-29',
        amountCOP: 348_000,
        expenseId: 'exp-2026-07-29-348000',
        concept: 'Compra 2026-07-29',
      },
    ]);
  });

  it('DC Tech: un abono del mismo día NO paga la compra si el dueño no lo dice', () => {
    // Abono de 70.000 a las 12:02 y compra de 474.000 el mismo día.
    const result = runCascade([
      expense('2026-09-13', 474_000, 12),
      sale('2026-09-13', 70_000, 12, 2),
    ]);
    const [row] = result.expenses;
    expect(row.fromSalesCOP).toBe(0);
    expect(row.missingCOP).toBe(474_000);
    // Pero sí se informa que había esa plata, para que el dueño decida.
    expect(row.salesAvailableCOP).toBe(70_000);
  });

  it('la reinversión solo cuenta si el dueño la declara', () => {
    const result = runCascade(
      [sale('2026-08-20', 390_500), expense('2026-08-20', 888_000)],
      [],
      new Map([['exp-2026-08-20-888000', 390_500]]),
    );
    expect(result.fromSalesCOP).toBe(390_500);
    expect(result.suggestions).toMatchObject([
      { date: '2026-08-20', amountCOP: 497_500 },
    ]);
  });

  it('lo declarado de ventas no puede inventar plata que no había', () => {
    const result = runCascade(
      [sale('2026-09-01', 100_000), expense('2026-09-02', 300_000)],
      [],
      new Map([['exp-2026-09-02-300000', 300_000]]),
    );
    const [row] = result.expenses;
    expect(row.declaredFromSalesCOP).toBe(300_000);
    expect(row.fromSalesCOP).toBe(100_000);
    expect(row.missingCOP).toBe(200_000);
  });

  it('un aporte general del mismo día cubre el pago aunque se anote más tarde', () => {
    const result = runCascade([
      expense('2026-08-20', 888_000, 8),
      contribution('2026-08-20', 888_000, 12),
    ]);
    expect(result.fromCapitalCOP).toBe(888_000);
    expect(result.suggestions).toEqual([]);
  });

  it('lo sobrante de un aporte general queda para los gastos siguientes', () => {
    const result = runCascade([
      contribution('2026-07-01', 1_000_000),
      expense('2026-07-03', 500_000),
      expense('2026-07-04', 600_000),
    ]);
    expect(result.fromCapitalCOP).toBe(1_000_000);
    expect(result.suggestions).toMatchObject([
      { date: '2026-07-04', amountCOP: 100_000 },
    ]);
  });

  it('un retiro sale primero de la plata de ventas', () => {
    const result = runCascade(
      [
        sale('2026-09-01', 300_000),
        withdrawal('2026-09-02', 300_000),
        expense('2026-09-03', 200_000),
      ],
      [],
      new Map([['exp-2026-09-03-200000', 200_000]]),
    );
    // Las ventas se las llevó el retiro: la compra no tuvo de dónde salir.
    const [row] = result.expenses;
    expect(row.fromSalesCOP).toBe(0);
    expect(row.missingCOP).toBe(200_000);
  });

  it('un aporte vinculado cubre SU gasto aunque tenga otra fecha, y no se usa para otros', () => {
    const result = runCascade(
      [
        expense('2026-09-13', 474_000),
        expense('2026-09-25', 921_000),
        contribution('2026-09-30', 921_000),
      ],
      [
        {
          movementId: 'cap-2026-09-30-921000',
          expenseId: 'exp-2026-09-25-921000',
          amountCOP: 921_000,
        },
      ],
    );
    const byId = Object.fromEntries(
      result.expenses.map((e) => [e.expenseId, e]),
    );
    expect(byId['exp-2026-09-25-921000'].linkedCOP).toBe(921_000);
    expect(byId['exp-2026-09-25-921000'].missingCOP).toBe(0);
    expect(byId['exp-2026-09-13-474000'].missingCOP).toBe(474_000);
  });

  it('un aporte vinculado en parte deja el resto libre para la cascada', () => {
    const result = runCascade(
      [
        contribution('2026-09-01', 500_000),
        expense('2026-09-02', 300_000),
        expense('2026-09-03', 400_000),
      ],
      [
        {
          movementId: 'cap-2026-09-01-500000',
          expenseId: 'exp-2026-09-03-400000',
          amountCOP: 200_000,
        },
      ],
    );
    const byId = Object.fromEntries(
      result.expenses.map((e) => [e.expenseId, e]),
    );
    expect(byId['exp-2026-09-02-300000'].fromOwnerCOP).toBe(300_000);
    expect(byId['exp-2026-09-03-400000'].linkedCOP).toBe(200_000);
    expect(byId['exp-2026-09-03-400000'].missingCOP).toBe(200_000);
  });
});
