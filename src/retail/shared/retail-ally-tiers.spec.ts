import { allyDiscountCOP, allyDiscountPct } from './retail-ally-tiers';

// La tabla que dio Diego: >50.000 → 12%, >1.000.000 → 15%, >2.500.000 → 18%.
const tiers = [
  { aboveCOP: 1_000_000, pct: 15 },
  { aboveCOP: 50_000, pct: 12 },
  { aboveCOP: 2_500_000, pct: 18 },
];

describe('escalas de aliados', () => {
  it('por debajo de la primera escala no hay descuento', () => {
    expect(allyDiscountPct(tiers, 40_000)).toBe(0);
  });

  it('el piso es estricto: exactamente 50.000 no alcanza', () => {
    expect(allyDiscountPct(tiers, 50_000)).toBe(0);
    expect(allyDiscountPct(tiers, 50_001)).toBe(12);
  });

  it('una tasa sobre todo el monto, no por tramos', () => {
    expect(allyDiscountPct(tiers, 1_200_000)).toBe(15);
    expect(allyDiscountCOP(tiers, 1_200_000)).toBe(180_000);
  });

  it('respeta los otros bordes', () => {
    expect(allyDiscountPct(tiers, 1_000_000)).toBe(12);
    expect(allyDiscountPct(tiers, 2_500_000)).toBe(15);
    expect(allyDiscountPct(tiers, 2_500_001)).toBe(18);
  });

  it('una sola escala plana', () => {
    expect(allyDiscountPct([{ aboveCOP: 0, pct: 15 }], 10_000)).toBe(15);
  });

  it('sin escalas no hay descuento', () => {
    expect(allyDiscountCOP([], 3_000_000)).toBe(0);
  });
});
