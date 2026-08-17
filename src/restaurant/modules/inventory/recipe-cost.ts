// Costeo de recetas — funciones puras, sin Prisma ni Nest.
//
// Fuente ÚNICA de la fórmula de costo. La usan dos consumidores que no pueden
// divergir:
//   1. `InventoryService.toRecipeLineDto` → lo que se ve en "Costos x Producto".
//   2. `OrdersService.sendToKitchen`      → el costo que se congela en la venta.
//
// Si estas dos usaran fórmulas distintas, el margen histórico no cuadraría con
// el margen que muestra la carta y no habría forma de saber cuál miente.

import { convertQuantity, type ConversionCtx } from './unit-conversion';

/** Lo mínimo que necesita el costeo de un ingrediente. */
export interface CostableIngredient extends ConversionCtx {
  /** Costo por unidad de RECETA, ya neto de la merma técnica del ingrediente. */
  netUnitCost: number;
}

/** Lo mínimo que necesita el costeo de una línea de receta. */
export interface CostableRecipeLine {
  quantity: number;
  /** Unidad en la que está escrita la línea (puede no ser la de receta). */
  unit: string;
  /** Merma al preparar ESTA línea, aparte de la merma técnica del ingrediente. */
  wastePercent?: number | null;
}

/**
 * Costo de 1 unidad de `to`, dado el costo por unidad de `from`.
 *
 * Se invierte la conversión a propósito: para saber cuánto cuesta 1 kg cuando el
 * costo está por g, hay que saber cuántos g trae 1 kg.
 */
export function convertUnitCost(
  costPerFromUnit: number,
  from: string,
  to: string,
  ctx?: ConversionCtx,
): number {
  const oneTo = convertQuantity(1, to, from, ctx);
  return costPerFromUnit * oneTo;
}

/** Costo de una línea de receta para UNA unidad del producto. */
export function recipeLineCost(
  line: CostableRecipeLine,
  ingredient: CostableIngredient,
): number {
  const unitCost = convertUnitCost(
    ingredient.netUnitCost,
    ingredient.recipeUnit,
    line.unit,
    ingredient,
  );
  // Merma por línea: si se pierde X% al preparar, se necesita más cantidad.
  const wastePercent = line.wastePercent ?? 0;
  return line.quantity * (1 + wastePercent / 100) * unitCost;
}

/**
 * Costo de receta de UNA unidad del producto, en pesos enteros.
 *
 * Devuelve `null` cuando el producto no tiene receta cargada. Es una distinción
 * deliberada: `null` significa "no sabemos cuánto costó" y 0 significa "costó
 * cero". Confundirlas infla el margen y hace que el dashboard reporte una
 * utilidad que no existe.
 */
export function productUnitCostCOP(
  lines: Array<{ line: CostableRecipeLine; ingredient: CostableIngredient }>,
): number | null {
  if (lines.length === 0) return null;
  const total = lines.reduce(
    (sum, { line, ingredient }) => sum + recipeLineCost(line, ingredient),
    0,
  );
  return Math.round(total);
}
