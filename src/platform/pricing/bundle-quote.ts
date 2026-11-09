/**
 * Cotización de un combo de verticales. Función pura: no lee la base.
 *
 * Regla (docs/PLAN_CUENTA_DOS_VERTICALES.md §5):
 *   - La vertical más cara del combo va a precio completo.
 *   - Cada vertical adicional lleva `bundleBps` de descuento (3000 = 30%).
 *   - Todas en el mismo plan; solo verticales distintas.
 *   - El anticipo (`termBps` por vertical) se aplica encima, multiplicativo.
 *   - Todo en USD (el ancla) y el COP se deriva POR LÍNEA con el redondeo
 *     comercial. El total es la suma de las líneas: el cliente lo verifica de
 *     cabeza y cada línea del cobro cuadra sola.
 *
 * Réplica exacta en el frontend: `quoteBundle` en core/config/pricing.config.ts.
 * Si divergen, la landing publica un precio y el cobro emite otro.
 */

export type BundleLineInput = {
  verticalCode: string;
  /** Precio de lista mensual en USD del plan elegido. */
  priceUSD: number;
  /** Descuento por anticipo para ese vertical/plan/término (0 si es mensual). */
  termBps: number;
};

export type BundleLine = {
  verticalCode: string;
  /** 0 = la que va a precio completo. */
  position: number;
  listMonthlyUSD: number;
  listMonthlyCOP: number;
  bundleBps: number;
  termBps: number;
  /** Mensual con combo y anticipo, en USD (2 decimales). */
  monthlyUSD: number;
  /** Mensual con combo y anticipo, en COP redondeado. */
  monthlyCOP: number;
};

export type BundleQuote = {
  termMonths: number;
  bundleBps: number;
  lines: BundleLine[];
  /** Suma de los precios de lista (lo que pagaría por separado, mes a mes). */
  listMonthlyCOP: number;
  /** Suma de las líneas con combo y anticipo. */
  monthlyCOP: number;
  /** Lo que paga de una por el término. */
  totalCOP: number;
  /** Ahorro del término completo contra pagar por separado mes a mes. */
  savingCOP: number;
  /** Ahorro en bps sobre lo que pagaría por separado (para mostrar "−13%"). */
  savingBps: number;
};

/** Orden estable de desempate: el mismo de `VERTICAL_CODES`. */
const VERTICAL_ORDER = ['restaurant', 'barber', 'retail'];

export function quoteBundle(input: {
  lines: BundleLineInput[];
  bundleBps: number;
  termMonths: number;
  usdToCop: (usd: number) => number;
}): BundleQuote {
  const term = Math.max(1, Math.round(input.termMonths));
  const unique = new Map<string, BundleLineInput>();
  for (const line of input.lines) unique.set(line.verticalCode, line);

  const ordered = [...unique.values()].sort(
    (a, b) =>
      b.priceUSD - a.priceUSD ||
      VERTICAL_ORDER.indexOf(a.verticalCode) -
        VERTICAL_ORDER.indexOf(b.verticalCode),
  );

  const lines: BundleLine[] = ordered.map((line, position) => {
    const bundleBps = position === 0 ? 0 : input.bundleBps;
    const monthlyUSD =
      (line.priceUSD * (10000 - bundleBps) * (10000 - line.termBps)) / 1e8;
    return {
      verticalCode: line.verticalCode,
      position,
      listMonthlyUSD: line.priceUSD,
      listMonthlyCOP: input.usdToCop(line.priceUSD),
      bundleBps,
      termBps: line.termBps,
      monthlyUSD: Math.round(monthlyUSD * 100) / 100,
      monthlyCOP: input.usdToCop(monthlyUSD),
    };
  });

  const listMonthlyCOP = lines.reduce((sum, l) => sum + l.listMonthlyCOP, 0);
  const monthlyCOP = lines.reduce((sum, l) => sum + l.monthlyCOP, 0);
  const totalCOP = monthlyCOP * term;
  const savingCOP = listMonthlyCOP * term - totalCOP;

  return {
    termMonths: term,
    bundleBps: input.bundleBps,
    lines,
    listMonthlyCOP,
    monthlyCOP,
    totalCOP,
    savingCOP,
    savingBps:
      listMonthlyCOP > 0
        ? Math.round((savingCOP / (listMonthlyCOP * term)) * 10000)
        : 0,
  };
}

/** Combos que se publican: todas las parejas y las tres. */
export const BUNDLE_COMBOS: string[][] = [
  ['restaurant', 'barber'],
  ['restaurant', 'retail'],
  ['barber', 'retail'],
  ['restaurant', 'barber', 'retail'],
];

/** Techo del % por vertical adicional (dedo gordo: 50% sería regalar). */
export const MAX_BUNDLE_BPS = 5000;
