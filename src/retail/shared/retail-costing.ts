/**
 * [VERTICAL_RETAIL] Costo promedio ponderado.
 *
 * POR QUÉ EXISTE. `RetailProduct.costCOP` hacía tres trabajos con un solo
 * número: base del precio, costo de la venta y valor del inventario. Mientras
 * todo se compra al mismo precio los tres coinciden y nadie nota nada. Se
 * separan en cuanto entra mercancía a otro costo — el caso que lo destapó fue un
 * sobrante que el proveedor mandó por error y entró a $0: reponer una unidad
 * sigue costando 16.000, pero lo que hay en bodega ya no costó 16.000 cada una.
 *
 * Desde entonces son dos números con dos trabajos:
 *
 *   · `costCOP`    — COSTO DE REPOSICIÓN. Lo que cuesta traer otra. Manda en la
 *                    calculadora de precios, que es lo correcto: para decidir a
 *                    cuánto vender importa lo que costará reemplazarla, no lo
 *                    que costó la que está en el estante.
 *   · `avgCostCOP` — COSTO PROMEDIO. Lo que costó, en promedio, cada unidad de
 *                    las que hay. Manda al medir la utilidad y al valorar el
 *                    inventario.
 *
 * POR QUÉ PROMEDIO Y NO POR LOTES. La mercancía es fungible: al vender una
 * Mantequilla Sandía no hay forma de saber si salió una de las que llegaron
 * gratis o una de las pagadas — están en la misma caja y son idénticas. Decir
 * "esa venta dejó 100%" sería una historia sobre cuál unidad salió, no un dato.
 * Con 77 unidades por las que se pagaron 1.040.000, lo que sí es exacto es que
 * cada una costó 13.506. El promedio no aproxima la verdad: es la única verdad
 * disponible.
 */

/**
 * El promedio después de que entra mercancía.
 *
 *   nuevo = (stockAntes × promedioAntes + entrada × costoEntrada)
 *           ─────────────────────────────────────────────────────
 *                        stockAntes + entrada
 *
 * SOLO LAS ENTRADAS LO MUEVEN. Vender no cambia lo que costó lo que queda en la
 * estantería, así que las salidas no llaman a esta función.
 *
 * Con stock previo en cero o negativo el promedio anterior no tiene sobre qué
 * ponderar y el nuevo es, sin más, el costo de lo que entró.
 */
export function weightedAverageCost(params: {
  /** Unidades que había ANTES de esta entrada. */
  stockBefore: number;
  /** Promedio vigente. Si nunca se calculó, pásese el costo de referencia. */
  avgCostBefore: number;
  /** Unidades que entran. Siempre positivo. */
  quantity: number;
  /** Lo que costó cada unidad de las que entran. 0 es válido: llegó de regalo. */
  unitCostCOP: number;
}): number {
  const { stockBefore, avgCostBefore, quantity, unitCostCOP } = params;
  if (quantity <= 0) return avgCostBefore;
  if (stockBefore <= 0) return Math.max(0, Math.round(unitCostCOP));

  const value = stockBefore * avgCostBefore + quantity * unitCostCOP;
  return Math.max(0, Math.round(value / (stockBefore + quantity)));
}

/**
 * El promedio con el que hay que costear una venta hoy.
 *
 * Cae a `costCOP` mientras `avgCostCOP` sea NULL: los productos anteriores a
 * este cambio no tienen promedio hasta que entre mercancía, y hasta entonces el
 * último costo pagado es la mejor estimación que existe.
 */
export function costingCostCOP(product: {
  costCOP: number;
  avgCostCOP?: number | null;
}): number {
  return product.avgCostCOP ?? product.costCOP;
}
