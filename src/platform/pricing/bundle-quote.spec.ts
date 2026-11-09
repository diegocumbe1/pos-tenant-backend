import { quoteBundle } from './bundle-quote';
import { usdToCop } from './plan-pricing.service';

const at3680 = (usd: number) => usdToCop(usd, 3680);
const line = (verticalCode: string, priceUSD: number, termBps = 0) => ({
  verticalCode,
  priceUSD,
  termBps,
});

describe('quoteBundle', () => {
  it('restaurante + agenda Pro: la más cara completa y la otra −30% (tabla validada)', () => {
    const q = quoteBundle({
      lines: [line('barber', 25), line('restaurant', 33)],
      bundleBps: 3000,
      termMonths: 1,
      usdToCop: at3680,
    });
    expect(q.lines.map((l) => [l.verticalCode, l.monthlyCOP])).toEqual([
      ['restaurant', 121500],
      ['barber', 64500],
    ]);
    expect(q.monthlyCOP).toBe(186000);
    expect(q.listMonthlyCOP).toBe(213500);
    expect(q.savingCOP).toBe(27500);
  });

  it('las tres verticales Pro: dos adicionales al −30%', () => {
    const q = quoteBundle({
      lines: [line('restaurant', 33), line('barber', 25), line('retail', 22)],
      bundleBps: 3000,
      termMonths: 1,
      usdToCop: at3680,
    });
    expect(q.monthlyCOP).toBe(242500);
    expect(q.listMonthlyCOP).toBe(294500);
    expect(q.lines.map((l) => l.bundleBps)).toEqual([0, 3000, 3000]);
  });

  it('el total es la suma de las líneas por los meses, y el anticipo va encima', () => {
    const q = quoteBundle({
      lines: [line('restaurant', 33, 1700), line('barber', 25, 1700)],
      bundleBps: 3000,
      termMonths: 12,
      usdToCop: at3680,
    });
    expect(q.monthlyCOP).toBe(154500);
    expect(q.totalCOP).toBe(154500 * 12);
    expect(q.savingCOP).toBe(213500 * 12 - 154500 * 12);
  });

  it('empate de precio: desempata por el orden fijo de verticales, el total no cambia', () => {
    const a = quoteBundle({
      lines: [line('retail', 25), line('barber', 25)],
      bundleBps: 3000,
      termMonths: 1,
      usdToCop: at3680,
    });
    const b = quoteBundle({
      lines: [line('barber', 25), line('retail', 25)],
      bundleBps: 3000,
      termMonths: 1,
      usdToCop: at3680,
    });
    expect(a.lines[0].verticalCode).toBe('barber');
    expect(a.monthlyCOP).toBe(b.monthlyCOP);
  });

  it('una vertical repetida no cuenta dos veces', () => {
    const q = quoteBundle({
      lines: [line('restaurant', 33), line('restaurant', 33)],
      bundleBps: 3000,
      termMonths: 1,
      usdToCop: at3680,
    });
    expect(q.lines).toHaveLength(1);
    expect(q.savingCOP).toBe(0);
  });

  it('con 0% de combo es igual a pagar por separado', () => {
    const q = quoteBundle({
      lines: [line('restaurant', 33), line('barber', 25)],
      bundleBps: 0,
      termMonths: 1,
      usdToCop: at3680,
    });
    expect(q.monthlyCOP).toBe(q.listMonthlyCOP);
  });
});
