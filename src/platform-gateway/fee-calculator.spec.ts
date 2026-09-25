import {
  DEFAULT_FEE_RATES,
  FeeMethod,
  FeeRate,
  quoteFee,
} from './fee-calculator';

const rateOf = (method: FeeMethod): FeeRate =>
  DEFAULT_FEE_RATES.find((r) => r.method === method)!;

describe('quoteFee · el caso que preguntó el usuario: $92.000', () => {
  it('datáfono cuesta menos que el link, y la diferencia es real', () => {
    const datafono = quoteFee({
      amountCOP: 92_000,
      rate: rateOf('CARD_PRESENT'),
    });
    const link = quoteFee({ amountCOP: 92_000, rate: rateOf('CARD_ONLINE') });

    // 92.000 × 1,98% = 1.822 + IVA 19% = 2.168
    expect(datafono.commission).toBe(1_822);
    expect(datafono.totalCost).toBe(2_168);

    // 92.000 × 2,65% + 700 = 3.138 + IVA = 3.734
    expect(link.commission).toBe(3_138);
    expect(link.totalCost).toBe(3_734);

    expect(link.totalCost).toBeGreaterThan(datafono.totalCost);
  });

  it('sin IVA en la venta, la retención de IVA es cero', () => {
    const q = quoteFee({ amountCOP: 92_000, rate: rateOf('CARD_PRESENT') });
    expect(q.saleIva).toBe(0);
    expect(q.reteIva).toBe(0);
    // Retefuente 1,5% y ICA 0,2% sobre los 92.000 completos.
    expect(q.retefuente).toBe(1_380);
    expect(q.reteIca).toBe(184);
  });

  it('con IVA del 19% la base se despeja y el reteIVA sale del IVA', () => {
    const q = quoteFee({
      amountCOP: 92_000,
      rate: rateOf('CARD_PRESENT'),
      saleIvaBps: 1900,
    });

    expect(q.taxableBase).toBe(77_311);
    expect(q.saleIva).toBe(14_689);
    expect(q.taxableBase + q.saleIva).toBe(92_000);
    // reteIVA = 15% del IVA, no del total.
    expect(q.reteIva).toBe(2_203);
  });
});

describe('quoteFee · costo vs retención', () => {
  const q = quoteFee({ amountCOP: 120_000, rate: rateOf('CARD_PRESENT') });

  it('lo depositado descuenta comisión Y retenciones', () => {
    expect(q.deposited).toBe(
      120_000 - q.totalCost - q.retefuente - q.reteIca - q.reteIva,
    );
  });

  it('el neto real solo descuenta el costo: las retenciones vuelven', () => {
    expect(q.effectiveNet).toBe(120_000 - q.totalCost);
    expect(q.effectiveNet).toBeGreaterThan(q.deposited);
  });

  it('el % de costo es mucho menor que el hueco del depósito', () => {
    expect(q.costPercent).toBeCloseTo(2.36, 1);
    expect(q.depositGapPercent).toBeGreaterThan(q.costPercent);
  });
});

describe('quoteFee · medios sin comisión', () => {
  it('Bre-B entra completo', () => {
    const q = quoteFee({ amountCOP: 120_000, rate: rateOf('BREB') });
    expect(q.totalCost).toBe(0);
    expect(q.totalWithheld).toBe(0);
    expect(q.deposited).toBe(120_000);
    expect(q.costPercent).toBe(0);
  });

  it('PSE paga comisión pero no retenciones: no pasa por el adquirente', () => {
    const q = quoteFee({ amountCOP: 120_000, rate: rateOf('PSE') });
    expect(q.totalCost).toBeGreaterThan(0);
    expect(q.totalWithheld).toBe(0);
  });
});

describe('quoteFee · el peso de la comisión fija', () => {
  it('castiga más los tickets chicos', () => {
    const chico = quoteFee({ amountCOP: 20_000, rate: rateOf('CARD_ONLINE') });
    const grande = quoteFee({
      amountCOP: 2_000_000,
      rate: rateOf('CARD_ONLINE'),
    });
    expect(chico.costPercent).toBeGreaterThan(grande.costPercent);
    // El piso es 2,65% × 1,19 = 3,15%.
    expect(grande.costPercent).toBeCloseTo(3.19, 1);
  });

  it('no explota con monto cero', () => {
    const q = quoteFee({ amountCOP: 0, rate: rateOf('BREB') });
    expect(q.costPercent).toBe(0);
    expect(q.depositGapPercent).toBe(0);
  });
});
