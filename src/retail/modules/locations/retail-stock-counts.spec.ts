import { summarize } from './retail-stock-counts.service';

const tiers = [
  { aboveCOP: 50_000, pct: 12 },
  { aboveCOP: 1_000_000, pct: 15 },
];

describe('resumen de una revista', () => {
  it('un renglón sin tocar cuenta como "está igual"', () => {
    const summary = summarize(
      [{ countedQty: null, expectedQty: 5, unitPriceCOP: 10_000 }],
      'ALLY',
      tiers,
    );
    expect(summary.soldUnits).toBe(0);
    expect(summary.countedUnits).toBe(5);
  });

  it('en un aliado lo que falta es lo vendido, con su escala', () => {
    const summary = summarize(
      [
        // Quedaban 6, hay 2: vendió 4 a 285.000 = 1.140.000 → 15%.
        { countedQty: 2, expectedQty: 6, unitPriceCOP: 285_000 },
        // Sobra 1: no se vende, se trae de la principal.
        { countedQty: 4, expectedQty: 3, unitPriceCOP: 50_000 },
      ],
      'ALLY',
      tiers,
    );
    expect(summary.soldUnits).toBe(4);
    expect(summary.soldValueCOP).toBe(1_140_000);
    expect(summary.discountPct).toBe(15);
    expect(summary.discountCOP).toBe(171_000);
    expect(summary.netCOP).toBe(969_000);
    expect(summary.extraUnits).toBe(1);
  });

  it('en exhibición lo que falta se vendió, sin descuento de aliado', () => {
    // Se dejaron 4, quedan 3: falta 1, se vendió 1.
    const summary = summarize(
      [{ countedQty: 3, expectedQty: 4, unitPriceCOP: 285_000 }],
      'EXHIBITION',
      tiers,
    );
    expect(summary.missingUnits).toBe(1);
    expect(summary.soldUnits).toBe(1);
    expect(summary.soldValueCOP).toBe(285_000);
    expect(summary.discountPct).toBe(0);
    expect(summary.netCOP).toBe(285_000);
  });

  it('en la principal lo que falta es un ajuste, no una venta', () => {
    const summary = summarize(
      [{ countedQty: 3, expectedQty: 4, unitPriceCOP: 285_000 }],
      'PRINCIPAL',
      tiers,
    );
    expect(summary.missingUnits).toBe(1);
    expect(summary.soldUnits).toBe(0);
    expect(summary.netCOP).toBe(0);
  });
});
