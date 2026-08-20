// [VERTICAL_RETAIL] Rentabilidad de un precio: la única fuente de las fórmulas.
//
// Antes de esto el margen se calculaba a mano en `toProductDto`. Con precios
// por volumen aparecen tres precios sobre el mismo costo (mínimo, venta, x6,
// x12) y cada uno necesita utilidad, margen y descuento: si cada consumidor
// escribe su propia resta, tarde o temprano dos pantallas muestran cifras
// distintas del mismo producto. Todo pasa por aquí.
//
// Convenciones que ya usa el proyecto y que se respetan:
//  - El dinero es entero COP (`Int` en Prisma). Nada de Decimal ni de string.
//  - El % es margen sobre el PRECIO DE VENTA, no markup sobre el costo:
//    "de cada venta me queda X%". Escala 0–100 con un decimal.

/** Un escalón de precio por volumen tal como se guarda en el producto. */
export type WholesaleTierKey = 'wholesalePrice6COP' | 'wholesalePrice12COP';

/**
 * Escalones soportados, de mayor a menor cantidad.
 *
 * El orden importa: `resolveProductUnitPriceCOP` recorre la lista y se queda
 * con el primero que aplique, así que 12+ tiene que evaluarse antes que 6+.
 * Esta primera versión son dos escalones fijos a propósito: una tabla de
 * reglas configurables no se necesita todavía y costaría migración, UI y
 * validación de solapes.
 */
export const WHOLESALE_TIERS: ReadonlyArray<{
  minQty: number;
  field: WholesaleTierKey;
}> = [
  { minQty: 12, field: 'wholesalePrice12COP' },
  { minQty: 6, field: 'wholesalePrice6COP' },
];

/** Lo mínimo que hace falta para razonar sobre el precio de un producto. */
export type PricedProduct = {
  costCOP: number;
  priceCOP: number;
  wholesalePrice6COP?: number | null;
  wholesalePrice12COP?: number | null;
};

export type PriceMetrics = {
  /** Lo que queda por unidad vendida a ese precio. Negativo = se pierde plata. */
  profitPerUnitCOP: number;
  /** Margen sobre el precio, 0–100 con un decimal. */
  marginPct: number;
  /** Cuánto más barato es que el PVP, 0–100 con un decimal. null si no aplica. */
  discountPct: number | null;
};

function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Costo con el que se calcula rentabilidad.
 *
 * Hoy es el costo de compra tal cual: Lynko todavía no distribuye flete ni
 * otros costos de adquisición sobre el producto. Cuando exista ese costo real
 * (compra + flete + nacionalización), se cambia AQUÍ y todos los márgenes —
 * venta, mínimo y los dos escalones mayoristas— pasan a usarlo a la vez.
 */
export function effectiveCostCOP(
  product: Pick<PricedProduct, 'costCOP'>,
): number {
  return product.costCOP;
}

/**
 * Utilidad, margen y descuento de un precio.
 *
 * `retailPriceCOP` es el PVP contra el que se compara para el descuento; se
 * omite cuando el precio evaluado ES el PVP (no tiene sentido decir que el
 * precio de venta tiene 0% de descuento sobre sí mismo).
 */
export function calculatePriceMetrics({
  priceCOP,
  costCOP,
  retailPriceCOP,
}: {
  priceCOP: number;
  costCOP: number;
  retailPriceCOP?: number | null;
}): PriceMetrics {
  const profitPerUnitCOP = priceCOP - costCOP;
  return {
    profitPerUnitCOP,
    // Un precio de 0 no tiene margen definido (sería división por cero), no
    // tiene margen 0: se reporta 0 y quien muestre el dato decide qué decir.
    marginPct:
      priceCOP > 0 ? oneDecimal((profitPerUnitCOP / priceCOP) * 100) : 0,
    discountPct:
      retailPriceCOP && retailPriceCOP > 0
        ? oneDecimal(((retailPriceCOP - priceCOP) / retailPriceCOP) * 100)
        : null,
  };
}

export type WholesaleTierMetrics = PriceMetrics & {
  minQty: number;
  priceCOP: number;
};

/**
 * Los escalones activos de un producto, ya con su rentabilidad, de menor a
 * mayor cantidad (que es como se leen en pantalla: "6+ … 12+ …").
 */
export function wholesaleTiersOf(
  product: PricedProduct,
): WholesaleTierMetrics[] {
  const costCOP = effectiveCostCOP(product);
  return WHOLESALE_TIERS.map(({ minQty, field }) => ({
    minQty,
    priceCOP: product[field],
  }))
    .filter(
      (tier): tier is { minQty: number; priceCOP: number } =>
        typeof tier.priceCOP === 'number',
    )
    .sort((a, b) => a.minQty - b.minQty)
    .map((tier) => ({
      minQty: tier.minQty,
      priceCOP: tier.priceCOP,
      ...calculatePriceMetrics({
        priceCOP: tier.priceCOP,
        costCOP,
        retailPriceCOP: product.priceCOP,
      }),
    }));
}

/**
 * Precio unitario que corresponde a una cantidad.
 *
 * TODAVÍA NO SE USA en POS ni en el catálogo público: existe para que cuando se
 * aplique, todos los módulos (POS, sitio público, cotizaciones) pregunten lo
 * mismo en vez de reimplementar la escalera cada uno. Aplicarla es cambiar el
 * llamador, no esta función.
 *
 *   1–5   → precio de venta
 *   6–11  → wholesalePrice6COP  (si está configurado)
 *   12+   → wholesalePrice12COP (si está configurado)
 *
 * Un escalón sin configurar se salta y se cae al siguiente que aplique, así
 * que un producto con solo x12 cobra PVP hasta 11 unidades.
 */
export function resolveProductUnitPriceCOP(
  product: PricedProduct,
  quantity: number,
): number {
  for (const { minQty, field } of WHOLESALE_TIERS) {
    const tierPrice = product[field];
    if (quantity >= minQty && typeof tierPrice === 'number') return tierPrice;
  }
  return product.priceCOP;
}
