/**
 * [VERTICAL_RETAIL] Escalas de descuento de los aliados.
 *
 * Ver docs/PLAN_RETAIL_AJUSTES_OCTUBRE_2026.md §5 (pos-system). Las define el
 * tenant —una sola escala o varias— y se aplican al TOTAL vendido entre una
 * revista y la siguiente, no a cada venta.
 *
 * UNA TASA SOBRE TODO EL MONTO, no por tramos como un impuesto: con
 * [>50.000 → 12%, >1.000.000 → 15%], vender 1.200.000 deja 15% de TODO
 * (180.000), no 12% del primer millón y 15% del resto.
 *
 * El piso es ESTRICTO ("mayor a 50.000"): exactamente 50.000 no alcanza la
 * escala. Por debajo de la primera escala no hay descuento.
 */

export type AllyTier = {
  /** Se aplica cuando el total SUPERA este valor. */
  aboveCOP: number;
  /** % de descuento sobre todo el total. */
  pct: number;
};

/** Lee lo guardado (JSON) y lo deja ordenado de menor a mayor piso. */
export function normalizeAllyTiers(value: unknown): AllyTier[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (row): row is AllyTier =>
        typeof row === 'object' &&
        row !== null &&
        Number.isFinite((row as AllyTier).aboveCOP) &&
        Number.isFinite((row as AllyTier).pct) &&
        (row as AllyTier).aboveCOP >= 0 &&
        (row as AllyTier).pct >= 0 &&
        (row as AllyTier).pct <= 100,
    )
    .map((row) => ({
      aboveCOP: Math.round(row.aboveCOP),
      pct: row.pct,
    }))
    .sort((a, b) => a.aboveCOP - b.aboveCOP);
}

/** El % que le toca a un total: el de la escala más alta cuyo piso supera. */
export function allyDiscountPct(tiers: AllyTier[], totalCOP: number): number {
  let pct = 0;
  for (const tier of normalizeAllyTiers(tiers)) {
    if (totalCOP > tier.aboveCOP) pct = tier.pct;
  }
  return pct;
}

/** Descuento en pesos, redondeado: lo que se queda el aliado. */
export function allyDiscountCOP(tiers: AllyTier[], totalCOP: number): number {
  return Math.round((totalCOP * allyDiscountPct(tiers, totalCOP)) / 100);
}
