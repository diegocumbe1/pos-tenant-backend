import {
  buildCashflow,
  summarizeMonth,
  CashflowInput,
} from './platform-cashflow';

const d = (s: string) => new Date(`${s}T12:00:00-05:00`);

function fixture(): CashflowInput {
  return {
    month: '2026-11',
    now: d('2026-11-12'),
    rate: 3230,
    payments: [
      // Cliente A: paga mensual, ya pagó noviembre.
      {
        tenantId: 'A',
        amount: 92000,
        currency: 'COP',
        paidAt: d('2026-11-11'),
        periodStart: d('2026-11-10'),
        periodEnd: d('2026-12-11'),
        kind: 'payment',
        countsAsRevenue: true,
      },
      // Cliente B: pagó 4 meses por adelantado en septiembre.
      {
        tenantId: 'B',
        amount: 164000,
        currency: 'COP',
        paidAt: d('2026-09-17'),
        periodStart: d('2026-10-15'),
        periodEnd: d('2027-02-16'),
        kind: 'payment',
        countsAsRevenue: true,
      },
      // Cliente C: renueva el 22 de noviembre.
      {
        tenantId: 'C',
        amount: 69500,
        currency: 'COP',
        paidAt: d('2026-10-22'),
        periodStart: d('2026-10-21'),
        periodEnd: d('2026-11-22'),
        kind: 'payment',
        countsAsRevenue: true,
      },
      // Bono: no es ingreso.
      {
        tenantId: 'D',
        amount: 0,
        currency: 'COP',
        paidAt: d('2026-08-08'),
        periodStart: d('2026-08-03'),
        periodEnd: d('2027-01-04'),
        kind: 'bonus',
        countsAsRevenue: false,
      },
    ],
    subscriptions: [
      {
        tenantId: 'A',
        tenantName: 'A',
        tenantStatus: 'ACTIVE',
        status: 'ACTIVE',
        billingCycle: 'monthly',
        currentPeriodEnd: d('2026-12-11'),
      },
      {
        tenantId: 'B',
        tenantName: 'B',
        tenantStatus: 'ACTIVE',
        status: 'ACTIVE',
        billingCycle: 'monthly',
        currentPeriodEnd: d('2027-02-16'),
      },
      {
        tenantId: 'C',
        tenantName: 'C',
        tenantStatus: 'ACTIVE',
        status: 'ACTIVE',
        billingCycle: 'monthly',
        currentPeriodEnd: d('2026-11-22'),
      },
      // Bono hasta enero y nunca pagó: no genera ingreso esperado.
      {
        tenantId: 'D',
        tenantName: 'D',
        tenantStatus: 'ACTIVE',
        status: 'ACTIVE',
        billingCycle: 'monthly',
        currentPeriodEnd: d('2027-01-04'),
      },
      // Cuenta propia gratis, sin pagos.
      {
        tenantId: 'E',
        tenantName: 'E',
        tenantStatus: 'ACTIVE',
        status: 'ACTIVE',
        billingCycle: 'monthly',
        currentPeriodEnd: d('2027-03-02'),
      },
      // Suspendida con pagos previos: tampoco.
      {
        tenantId: 'F',
        tenantName: 'F',
        tenantStatus: 'SUSPENDED',
        status: 'ACTIVE',
        billingCycle: 'monthly',
        currentPeriodEnd: d('2026-09-03'),
      },
    ],
    expenses: [
      {
        id: 'e1',
        concept: 'servidor',
        category: 'infra',
        amount: 5.72,
        currency: 'USD',
        status: 'paid',
        kind: 'recurring',
        incurredAt: d('2026-11-10'),
      },
      {
        id: 'e2',
        concept: 'db',
        category: 'infra',
        amount: 25,
        currency: 'USD',
        status: 'pending',
        kind: 'recurring',
        incurredAt: d('2026-11-12'),
      },
      {
        id: 'e3',
        concept: 'hosting',
        category: 'infra',
        amount: 40,
        currency: 'USD',
        status: 'paid',
        kind: 'one_time',
        incurredAt: d('2026-11-08'),
        exchangeRate: 3300,
      },
    ],
    commitments: [
      {
        concept: 'servidor',
        category: 'infra',
        amount: 5,
        currency: 'USD',
        recurrence: 'monthly',
        nextChargeAt: d('2026-12-10'),
      },
    ],
  };
}

describe('flujo de caja de plataforma', () => {
  it('noviembre: recibido, pendiente y esperado salen de los registros', () => {
    const m = summarizeMonth(fixture(), '2026-11');
    expect(m.income.received).toBe(92000);
    expect(m.income.pending).toBe(69500);
    expect(m.income.expected).toBe(161500);
  });

  it('el pago anticipado no suma caja en noviembre y aparece como prepago', () => {
    const m = summarizeMonth(fixture(), '2026-11');
    const b = m.income.clients.find((c) => c.tenantId === 'B');
    expect(b).toMatchObject({ status: 'prepaid', amountCOP: 0 });
    expect(
      m.income.clients.some(
        (c) => c.tenantId === 'D' || c.tenantId === 'E' || c.tenantId === 'F',
      ),
    ).toBe(false);
  });

  it('gastos: pagado, pendiente y TRM propia; el pendiente no resta a la caja', () => {
    const m = summarizeMonth(fixture(), '2026-11');
    expect(m.expenses.paid).toBe(
      Math.round((5.72 * 3230 + 40 * 3300) * 100) / 100,
    );
    expect(m.expenses.pending).toBe(25 * 3230);
    expect(m.cashBalance).toBe(
      Math.round((92000 - m.expenses.paid) * 100) / 100,
    );
    expect(m.projectedBalance).toBe(
      Math.round((161500 - m.expenses.total) * 100) / 100,
    );
  });

  it('devengado: Noviembre reparte el prepago de B (~41.000/mes) en vez de contar 164.000', () => {
    const m = summarizeMonth(fixture(), '2026-11');
    expect(m.operating.revenue).toBeGreaterThan(92000 / 2);
    expect(m.operating.revenue).toBeLessThan(92000 + 69500 + 60000);
  });

  it('mes futuro: proyecta el recurrente, no cobra a quien tiene el prepago', () => {
    const dec = summarizeMonth(fixture(), '2026-12');
    expect(dec.expenses.projected).toBe(5 * 3230);
    expect(dec.income.clients.find((c) => c.tenantId === 'B')?.status).toBe(
      'prepaid',
    );
    expect(dec.income.pending).toBeGreaterThan(0);
  });

  it('la serie trae acumulado de caja', () => {
    const r = buildCashflow(fixture());
    expect(r.series.length).toBeGreaterThan(3);
    expect(r.lifetime.received).toBe(92000 + 164000 + 69500);
  });

  // Reglas en las que se apoyan las gráficas del dashboard de finanzas.
  describe('serie para las gráficas', () => {
    const cur = '2026-11';

    it('los meses pasados no traen ingreso por cobrar inventado', () => {
      const r = buildCashflow(fixture());
      for (const p of r.series.filter((s) => s.month < cur)) {
        expect(p.projectedIncome).toBe(0);
      }
    });

    it('un cliente cobrado en un mes no figura también como pendiente o vencido ese mes', () => {
      const f = fixture();
      const r = buildCashflow(f);
      for (const p of r.series) {
        const lines = summarizeMonth(f, p.month).income.clients;
        const paid = new Set(
          lines.filter((c) => c.status === 'paid').map((c) => c.tenantId),
        );
        const dup = lines.filter(
          (c) =>
            (c.status === 'pending' || c.status === 'overdue') &&
            paid.has(c.tenantId),
        );
        expect(dup).toEqual([]);
      }
    });

    it('los meses futuros no traen caja confirmada (la gráfica los muestra solo como proyección)', () => {
      const r = buildCashflow(fixture());
      for (const p of r.series.filter((s) => s.month > cur)) {
        expect(p.received).toBe(0);
        expect(p.expensesPaid).toBe(0);
      }
    });

    it('el acumulado de caja del mes actual coincide con el acumulado real (lifetime)', () => {
      const r = buildCashflow(fixture());
      const now = r.series.find((s) => s.month === cur)!;
      expect(now.cumulativeCash).toBe(r.lifetime.cashBalance);
      expect(now.cumulativeOperating).toBe(r.lifetime.operatingResult);
    });
  });
});

describe('en camino al banco (datáfono)', () => {
  const base = (): CashflowInput => ({
    month: '2026-11',
    now: d('2026-11-22'), // domingo: ya pagó el sábado, aún no llega
    rate: 3230,
    payments: [
      {
        tenantId: 'T',
        amount: 363000,
        currency: 'COP',
        paidAt: d('2026-11-21'),
        periodStart: d('2026-11-21'),
        periodEnd: d('2027-11-21'),
        kind: 'payment',
        countsAsRevenue: true,
        channel: 'DATAFONO',
        settlementAccount: 'Bancolombia',
        expectedSettlementAt: d('2026-11-23'),
        settledAt: null,
        feeCOP: 8553,
        netCOP: 354447,
      },
    ],
    expenses: [],
    subscriptions: [
      {
        tenantId: 'T',
        tenantName: '317 Rompe Tus Límites',
        tenantStatus: 'ACTIVE',
        status: 'ACTIVE',
        billingCycle: 'monthly',
        currentPeriodEnd: d('2027-11-21'),
      },
    ],
    commitments: [],
  });

  it('el cliente ya pagó (caja del cliente) pero la plata va en camino al banco', () => {
    const m = summarizeMonth(base(), '2026-11');
    expect(m.income.received).toBe(363000);
    expect(m.bank.inTransit).toBe(363000);
    expect(m.bank.lines[0].account).toBe('Bancolombia');
    expect(m.bank.lines[0].overdue).toBe(false);
    expect(m.bank.fees).toBe(8553);
    expect(m.income.clients[0].settlement?.settledAt).toBeNull();
  });

  it('al llegar deja de estar en camino', () => {
    const input = base();
    input.payments[0].settledAt = d('2026-11-23');
    const m = summarizeMonth(input, '2026-11');
    expect(m.bank.inTransit).toBe(0);
    expect(m.income.received).toBe(363000);
  });

  it('pasado el día esperado sin confirmar queda atrasado', () => {
    const input = base();
    input.now = d('2026-11-25');
    const m = summarizeMonth(input, '2026-11');
    expect(m.bank.lines[0].overdue).toBe(true);
  });

  it('un pago sin trazabilidad no aparece en camino', () => {
    const input = base();
    input.payments[0].expectedSettlementAt = null;
    input.payments[0].channel = null;
    expect(summarizeMonth(input, '2026-11').bank.inTransit).toBe(0);
  });
});
