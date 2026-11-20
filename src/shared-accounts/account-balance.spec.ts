import {
  canchaPayments,
  checkPayment,
  consumoContributions,
  NO_PAYER,
  splitEqual,
  summarizeAccount,
  toRestaurantMethod,
} from './account-balance';

const lines = [
  { qty: 1, priceCOP: 5000 }, // Gatorade
  { qty: 2, priceCOP: 3000 }, // pasas
];

describe('summarizeAccount', () => {
  it('suma cancha y consumo por separado y el saldo de cada concepto', () => {
    const s = summarizeAccount({
      canchaTotalCOP: 60000,
      lines,
      payments: [
        { payerName: 'Camilo', concept: 'CANCHA', method: 'CASH', amountCOP: 8000 },
        { payerName: 'Camilo', concept: 'CONSUMO', method: 'CASH', amountCOP: 5000 },
      ],
    });
    expect(s.cancha).toEqual({ totalCOP: 60000, paidCOP: 8000, balanceCOP: 52000 });
    expect(s.consumo).toEqual({ totalCOP: 11000, paidCOP: 5000, balanceCOP: 6000 });
    expect(s.totalCOP).toBe(71000);
    expect(s.paidCOP).toBe(13000);
    expect(s.balanceCOP).toBe(58000);
    expect(s.settled).toBe(false);
  });

  it('resume qué pagó cada persona y de qué (el caso de los 8 amigos)', () => {
    const s = summarizeAccount({
      canchaTotalCOP: 60000,
      lines,
      payments: [
        { payerName: 'Camilo', concept: 'CANCHA', method: 'CASH', amountCOP: 7500 },
        { payerName: 'Camilo', concept: 'CONSUMO', method: 'CASH', amountCOP: 5000 },
        { payerName: 'Ana', concept: 'CANCHA', method: 'NEQUI', amountCOP: 7500 },
        { concept: 'CANCHA', method: 'CASH', amountCOP: 7500 },
      ],
    });
    const byName = Object.fromEntries(s.payers.map((p) => [p.payerName, p]));
    expect(byName.Camilo).toEqual({
      payerName: 'Camilo',
      canchaCOP: 7500,
      consumoCOP: 5000,
      totalCOP: 12500,
    });
    expect(byName.Ana.totalCOP).toBe(7500);
    expect(byName[NO_PAYER].totalCOP).toBe(7500);
    // El que más pagó va primero.
    expect(s.payers[0].payerName).toBe('Camilo');
  });

  it('un abono anulado no cuenta', () => {
    const s = summarizeAccount({
      canchaTotalCOP: 60000,
      lines: [],
      payments: [
        { concept: 'CANCHA', method: 'CASH', amountCOP: 10000 },
        {
          concept: 'CANCHA',
          method: 'CASH',
          amountCOP: 50000,
          voidedAt: new Date(),
        },
      ],
    });
    expect(s.cancha.paidCOP).toBe(10000);
    expect(s.payers).toHaveLength(1);
  });

  it('queda saldada solo cuando no falta nada en ningún concepto', () => {
    const base = {
      canchaTotalCOP: 60000,
      lines,
    };
    const soloCancha = summarizeAccount({
      ...base,
      payments: [{ concept: 'CANCHA', method: 'CASH', amountCOP: 60000 }],
    });
    expect(soloCancha.settled).toBe(false);
    const todo = summarizeAccount({
      ...base,
      payments: [
        { concept: 'CANCHA', method: 'CASH', amountCOP: 60000 },
        { concept: 'CONSUMO', method: 'CASH', amountCOP: 11000 },
      ],
    });
    expect(todo.settled).toBe(true);
    expect(todo.balanceCOP).toBe(0);
  });

  it('una cancha sin consumos se salda con solo pagar la cancha', () => {
    const s = summarizeAccount({
      canchaTotalCOP: 60000,
      lines: [],
      payments: [{ concept: 'CANCHA', method: 'CASH', amountCOP: 60000 }],
    });
    expect(s.settled).toBe(true);
  });
});

describe('checkPayment', () => {
  const summary = summarizeAccount({
    canchaTotalCOP: 60000,
    lines,
    payments: [{ concept: 'CANCHA', method: 'CASH', amountCOP: 55000 }],
  });

  it('acepta un abono dentro del saldo', () => {
    expect(checkPayment(summary, { concept: 'CANCHA', amountCOP: 5000 })).toEqual({ ok: true });
  });

  it('rechaza pasarse del saldo del concepto y dice cuánto falta', () => {
    const r = checkPayment(summary, { concept: 'CANCHA', amountCOP: 6000 });
    expect(r).toMatchObject({ ok: false, maxCOP: 5000 });
  });

  it('el saldo de cancha no sirve para pagar consumo', () => {
    const r = checkPayment(summary, { concept: 'CONSUMO', amountCOP: 12000 });
    expect(r).toMatchObject({ ok: false, maxCOP: 11000 });
  });

  it('un concepto ya pagado no recibe más', () => {
    const pagada = summarizeAccount({
      canchaTotalCOP: 60000,
      lines: [],
      payments: [{ concept: 'CANCHA', method: 'CASH', amountCOP: 60000 }],
    });
    const r = checkPayment(pagada, { concept: 'CANCHA', amountCOP: 1 });
    expect(r).toMatchObject({ ok: false, maxCOP: 0 });
  });

  it('rechaza valores no enteros o menores a 1', () => {
    expect(checkPayment(summary, { concept: 'CANCHA', amountCOP: 0 }).ok).toBe(false);
    expect(checkPayment(summary, { concept: 'CANCHA', amountCOP: 10.5 }).ok).toBe(false);
  });
});

describe('splitEqual', () => {
  it('60.000 entre 8 son 7.500 exactos', () => {
    expect(splitEqual(60000, 8)).toEqual(Array(8).fill(7500));
  });

  it('no pierde pesos: 100.000 entre 3', () => {
    const parts = splitEqual(100000, 3);
    expect(parts).toEqual([33334, 33333, 33333]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100000);
  });

  it('cualquier total y partes suman exacto', () => {
    for (const total of [0, 1, 7, 999, 60001]) {
      for (const n of [1, 2, 3, 7, 8, 11]) {
        expect(splitEqual(total, n).reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it('rechaza partes inválidas', () => {
    expect(() => splitEqual(1000, 0)).toThrow(RangeError);
    expect(() => splitEqual(1000, 2.5)).toThrow(RangeError);
  });
});

describe('asignación a cada negocio al cerrar', () => {
  it('mapea los medios de Agenda a los cuatro del restaurante', () => {
    expect(toRestaurantMethod('CASH')).toBe('cash');
    expect(toRestaurantMethod('CARD')).toBe('card');
    expect(toRestaurantMethod('BREB')).toBe('qr');
    expect(toRestaurantMethod('QR')).toBe('qr');
    expect(toRestaurantMethod('NEQUI')).toBe('transfer');
    expect(toRestaurantMethod('DAVIPLATA')).toBe('transfer');
    expect(toRestaurantMethod('WALLET:Nu')).toBe('transfer');
    expect(toRestaurantMethod('OTHER')).toBe('transfer');
  });

  const payments = [
    { concept: 'CANCHA' as const, method: 'CASH', amountCOP: 30000 },
    { concept: 'CANCHA' as const, method: 'NEQUI', amountCOP: 30000 },
    { concept: 'CONSUMO' as const, method: 'CASH', amountCOP: 5000 },
    { concept: 'CONSUMO' as const, method: 'NEQUI', amountCOP: 3000 },
    { concept: 'CONSUMO' as const, method: 'DAVIPLATA', amountCOP: 3000 },
    {
      concept: 'CONSUMO' as const,
      method: 'CASH',
      amountCOP: 9999,
      voidedAt: new Date(),
    },
  ];

  it('el consumo va al restaurante agrupado por medio, sin lo anulado ni la cancha', () => {
    const c = consumoContributions(payments);
    expect(c).toEqual(
      expect.arrayContaining([
        { method: 'cash', amount: 5000 },
        { method: 'transfer', amount: 6000 },
      ]),
    );
    expect(c.reduce((s, x) => s + x.amount, 0)).toBe(11000);
  });

  it('la cancha va a Agenda tal cual, sin lo anulado ni el consumo', () => {
    const c = canchaPayments(payments);
    expect(c).toEqual([
      { method: 'CASH', amountCOP: 30000 },
      { method: 'NEQUI', amountCOP: 30000 },
    ]);
  });

  it('lo que va a cada negocio suma lo abonado: nada se pierde ni se cuenta dos veces', () => {
    const cancha = canchaPayments(payments).reduce((s, x) => s + x.amountCOP, 0);
    const consumo = consumoContributions(payments).reduce((s, x) => s + x.amount, 0);
    expect(cancha + consumo).toBe(71000);
  });
});
