import { costFromListPrice, effectiveListDiscountPct } from './retail-pricing';

describe('precio de lista con descuento de distribuidor', () => {
  it('saca el costo del precio al público', () => {
    // El caso que lo originó: 285.000 con el 30% del distribuidor.
    expect(costFromListPrice(285_000, 30)).toBe(199_500);
  });

  it('redondea a pesos enteros', () => {
    expect(costFromListPrice(10_001, 33)).toBe(6_701);
  });

  it('con 0% el costo es el precio', () => {
    expect(costFromListPrice(50_000, 0)).toBe(50_000);
  });

  it('el % del producto pisa al del proveedor', () => {
    expect(effectiveListDiscountPct(25, 30)).toBe(25);
  });

  it('sin % propio usa el del proveedor', () => {
    expect(effectiveListDiscountPct(null, 30)).toBe(30);
    expect(effectiveListDiscountPct(undefined, 30)).toBe(30);
  });

  it('un 0% propio es un valor, no la ausencia de uno', () => {
    expect(effectiveListDiscountPct(0, 30)).toBe(0);
  });

  it('sin ninguno de los dos no hay con qué calcular', () => {
    expect(effectiveListDiscountPct(null, null)).toBeNull();
  });
});
