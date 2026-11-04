import {
  closingHints,
  computeChain,
  currentBalances,
  differenceRows,
  monthlyHistory,
  type ClosingInput,
} from './cash-closing-calc';
import type { CashMovement } from './finance.service';
import { dayEndCO } from '../common/date.util';

const at = (day: string) => new Date(`${day}T12:00:00-05:00`);
const sale = (
  day: string,
  amountCOP: number,
  method = 'CASH',
): CashMovement => ({
  at: at(day),
  direction: 'IN',
  category: 'SALES',
  origin: 'SALES',
  amountCOP,
  method,
});
const expense = (
  day: string,
  amountCOP: number,
  extra: Partial<CashMovement> = {},
): CashMovement => ({
  at: at(day),
  direction: 'OUT',
  category: 'OTHER',
  origin: 'EXPENSE',
  amountCOP,
  label: 'Gasto',
  ...extra,
});

const accounts = [
  { id: 'cash', name: 'Efectivo', type: 'CASH', defaultForMethods: ['CASH'] },
  {
    id: 'bank',
    name: 'Banco',
    type: 'BANK',
    defaultForMethods: ['TRANSFER', 'CARD'],
  },
];
const closing = (
  id: string,
  day: string,
  cash: number,
  bank: number,
  expectedTotalCOP = 0,
): ClosingInput => ({
  id,
  day,
  expectedTotalCOP,
  lines: [
    { accountId: 'cash', countedCOP: cash, expectedSnapshotCOP: null },
    { accountId: 'bank', countedCOP: bank, expectedSnapshotCOP: null },
  ],
});
const cop = (n: number) => `$${n}`;
const hintsFor = (
  rows: CashMovement[],
  closings: ClosingInput[],
  pending = 0,
  templates: Array<{ concept: string; amountCOP: number }> = [],
) => {
  const chain = computeChain(closings, rows, [], accounts);
  const entry = chain[chain.length - 1];
  return closingHints({
    entry,
    accounts,
    pendingSuggestedCOP: pending,
    templates,
    previous: chain.slice(0, -1),
    formatCOP: cop,
  });
};

describe('cierre de caja', () => {
  // Bella Chic, 3-nov-2026: Lynko decía 529.100; real 403.000 + 45.000.
  const history = [
    sale('2026-10-01', 1_786_400),
    expense('2026-10-02', 1_257_300),
  ];

  it('el primer cierre compara solo por total', () => {
    const [entry] = computeChain(
      [closing('c1', '2026-11-03', 403_000, 45_000, 529_100)],
      history,
      [],
      accounts,
    );
    expect(entry.expectedTotalCOP).toBe(529_100);
    expect(entry.countedTotalCOP).toBe(448_000);
    expect(entry.differenceCOP).toBe(-81_100);
    expect(entry.lines.every((l) => l.expectedCOP === null)).toBe(true);
  });

  it('la caja calculada más la diferencia da lo contado', () => {
    const chain = computeChain(
      [closing('c1', '2026-11-03', 403_000, 45_000)],
      history,
      [],
      accounts,
    );
    const rows = [...history, ...differenceRows(chain, dayEndCO)];
    const cash = rows.reduce(
      (s, r) => s + (r.direction === 'IN' ? r.amountCOP : -r.amountCOP),
      0,
    );
    expect(cash).toBe(448_000);
  });

  it('un gasto olvidado con fecha anterior reduce la diferencia, y la foto no cambia', () => {
    const [entry] = computeChain(
      [closing('c1', '2026-11-03', 403_000, 45_000, 529_100)],
      [...history, expense('2026-11-02', 50_000)],
      [],
      accounts,
    );
    expect(entry.differenceCOP).toBe(-31_100);
    expect(entry.differenceAtCloseCOP).toBe(-81_100);
  });

  it('un movimiento posterior al cierre no lo afecta', () => {
    const [entry] = computeChain(
      [closing('c1', '2026-11-03', 403_000, 45_000)],
      [...history, sale('2026-11-04', 90_000)],
      [],
      accounts,
    );
    expect(entry.differenceCOP).toBe(-81_100);
  });

  it('un faltante no se arrastra al cierre siguiente', () => {
    const chain = computeChain(
      [
        closing('c1', '2026-11-03', 403_000, 45_000),
        closing('c2', '2026-11-04', 503_000, 45_000),
      ],
      [...history, sale('2026-11-04', 100_000)],
      [],
      accounts,
    );
    expect(chain[0].differenceCOP).toBe(-81_100);
    expect(chain[1].differenceCOP).toBe(0);
    expect(chain[1].lines[0].expectedCOP).toBe(503_000);
  });

  it('desde el segundo cierre compara por cuenta y respeta traslados y medios', () => {
    const chain = computeChain(
      [
        closing('c1', '2026-11-03', 400_000, 50_000),
        closing('c2', '2026-11-05', 350_000, 200_000),
      ],
      [
        sale('2026-10-01', 450_000),
        sale('2026-11-04', 100_000, 'TRANSFER'),
        expense('2026-11-04', 10_000, { moneyAccountId: 'cash' }),
        expense('2026-11-04', 0),
      ],
      [
        {
          fromAccountId: 'cash',
          toAccountId: 'bank',
          amountCOP: 40_000,
          occurredAt: at('2026-11-05'),
        },
      ],
      accounts,
    );
    const [cashLine, bankLine] = chain[1].lines;
    expect(cashLine.expectedCOP).toBe(350_000);
    expect(bankLine.expectedCOP).toBe(190_000);
    expect(bankLine.differenceCOP).toBe(10_000);
    expect(chain[1].differenceCOP).toBe(10_000);
  });

  it('un gasto sin cuenta entra al total pero a ninguna cuenta', () => {
    const chain = computeChain(
      [
        closing('c1', '2026-11-03', 100_000, 0),
        closing('c2', '2026-11-04', 80_000, 0),
      ],
      [sale('2026-11-01', 100_000), expense('2026-11-04', 20_000)],
      [],
      accounts,
    );
    expect(chain[1].unassignedNetCOP).toBe(-20_000);
    expect(chain[1].differenceCOP).toBe(0);
    expect(chain[1].lines[0].differenceCOP).toBe(-20_000);
  });

  it('un gasto pagado por fuera con su aporte no mueve ninguna cuenta ni el total', () => {
    const chain = computeChain(
      [
        closing('c1', '2026-11-03', 100_000, 0),
        closing('c2', '2026-11-04', 100_000, 0),
      ],
      [
        sale('2026-11-01', 100_000),
        expense('2026-11-04', 30_000, { outsideBusiness: true }),
        {
          at: at('2026-11-04'),
          direction: 'IN',
          category: 'CAPITAL_CONTRIBUTION',
          origin: 'CAPITAL',
          amountCOP: 30_000,
          outsideBusiness: true,
        },
      ],
      [],
      accounts,
    );
    expect(chain[1].differenceCOP).toBe(0);
    expect(chain[1].lines[0].differenceCOP).toBe(0);
    expect(chain[1].unassignedNetCOP).toBe(0);
  });

  it('saldos actuales: lo contado más lo que se movió después', () => {
    const rows = [sale('2026-11-01', 100_000), sale('2026-11-05', 7_000)];
    const chain = computeChain(
      [closing('c1', '2026-11-03', 90_000, 5_000)],
      rows,
      [],
      accounts,
    );
    const now = currentBalances(chain[0], rows, [], accounts);
    expect(now?.balances.get('cash')).toBe(97_000);
    expect(now?.balances.get('bank')).toBe(5_000);
  });
});

describe('histórico por mes', () => {
  it('septiembre correcto, octubre con faltante y %, noviembre en curso', () => {
    const chain = computeChain(
      [
        closing('c1', '2026-09-30', 100_000, 0),
        closing('c2', '2026-10-31', 180_000, 0),
        closing('c3', '2026-11-02', 230_000, 0),
      ],
      [
        sale('2026-09-10', 100_000),
        sale('2026-10-10', 100_000),
        sale('2026-11-01', 50_000),
      ],
      [],
      accounts,
    );
    const months = monthlyHistory(chain, new Map(), '2026-11');
    const by = Object.fromEntries(months.map((m) => [m.month, m]));
    expect(by['2026-09'].status).toBe('OK');
    expect(by['2026-09'].includesFirstClosing).toBe(true);
    expect(by['2026-10'].status).toBe('SHORTAGE');
    expect(by['2026-10'].shortageCOP).toBe(20_000);
    expect(by['2026-10'].lossPct).toBe(20);
    expect(by['2026-11'].status).toBe('OK');
    expect(by['2026-11'].inProgress).toBe(true);
  });

  it('un faltante asumido sigue contando como pérdida aunque la diferencia ya sea 0', () => {
    const chain = computeChain(
      [closing('c1', '2026-10-31', 80_000, 0)],
      [sale('2026-10-10', 100_000), expense('2026-10-31', 20_000)],
      [],
      accounts,
    );
    expect(chain[0].differenceCOP).toBe(0);
    const [month] = monthlyHistory(chain, new Map([['c1', 20_000]]), '2026-10');
    expect(month.status).toBe('SHORTAGE');
    expect(month.shortageCOP).toBe(20_000);
    expect(month.lossPct).toBe(20);
    expect(month.correctClosings).toBe(0);
  });

  it('un mes sin cierres no aparece como correcto', () => {
    const chain = computeChain(
      [closing('c1', '2026-09-30', 0, 0)],
      [],
      [],
      accounts,
    );
    const months = monthlyHistory(chain, new Map(), '2026-11');
    expect(months.map((m) => m.status)).toEqual([
      'NO_CLOSINGS',
      'NO_CLOSINGS',
      'OK',
    ]);
  });

  it('bajo la tolerancia cuadra', () => {
    const chain = computeChain(
      [closing('c1', '2026-10-31', 99_500, 0)],
      [sale('2026-10-10', 100_000)],
      [],
      accounts,
    );
    expect(monthlyHistory(chain, new Map(), '2026-10')[0].status).toBe('OK');
  });
});

describe('qué pudo pasar', () => {
  const base = [sale('2026-11-01', 100_000)];
  const first = closing('c1', '2026-11-02', 100_000, 0);

  it('sin diferencia no inventa causas', () => {
    expect(hintsFor(base, [first])).toEqual([]);
  });

  it('diferencias opuestas: cuenta equivocada, aunque el total cuadre', () => {
    const hints = hintsFor(
      [...base, sale('2026-11-03', 50_000)],
      [first, closing('c2', '2026-11-03', 100_000, 50_000)],
    );
    expect(hints[0].code).toBe('WRONG_ACCOUNT');
  });

  it('el faltante es igual a un recurrente: alta confianza', () => {
    const hints = hintsFor(
      base,
      [first, closing('c2', '2026-11-03', 20_000, 0)],
      0,
      [{ concept: 'Arriendo', amountCOP: 80_000 }],
    );
    expect(hints[0].code).toBe('RECURRING_NOT_RECORDED');
    expect(hints[0].confidence).toBe('HIGH');
  });

  it('falta solo en efectivo', () => {
    const hints = hintsFor(base, [
      first,
      closing('c2', '2026-11-03', 70_000, 0),
    ]);
    expect(hints.map((h) => h.code)).toContain('CASH_ONLY');
  });

  it('el mismo gasto dos veces explica un sobrante', () => {
    const dup = { label: 'Bolsas' };
    const hints = hintsFor(
      [
        ...base,
        expense('2026-11-03', 15_000, dup),
        expense('2026-11-03', 15_000, dup),
      ],
      [first, closing('c2', '2026-11-03', 85_000, 0)],
    );
    expect(hints[0].code).toBe('DUPLICATE_EXPENSE');
  });

  it('sobrante con compras sin explicar', () => {
    const hints = hintsFor(
      base,
      [closing('c1', '2026-11-02', 300_000, 0)],
      200_000,
    );
    expect(hints[0].code).toBe('PENDING_FUNDING');
    expect(hints[0].confidence).toBe('HIGH');
  });

  it('faltantes seguidos', () => {
    const hints = hintsFor(base, [
      closing('c1', '2026-11-01', 90_000, 0),
      closing('c2', '2026-11-02', 80_000, 0),
      closing('c3', '2026-11-03', 70_000, 0),
    ]);
    const hint = hints.find((h) => h.code === 'REPEATED_SHORTAGE');
    expect(hint?.confidence).toBe('HIGH');
    expect(hint?.title).toContain('3');
  });
});
