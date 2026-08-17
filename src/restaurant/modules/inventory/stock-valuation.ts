// Valoración de inventario — costo promedio ponderado móvil. Funciones puras.
//
// EL BUG QUE ESTE MÓDULO EXISTE PARA IMPEDIR
// -----------------------------------------
// Antes, cada camino que movía stock recalculaba el costo así:
//
//     netUnitCost = totalPurchaseCost / netUsableQuantity
//
// `totalPurchaseCost` solo crecía (únicamente sumaba en las compras), pero se
// dividía por el stock RESTANTE. Cada venta reducía el divisor sin tocar el
// numerador, así que el costo unitario subía solo: con 27 unidades compradas por
// $60.291 el costo real era $2.233, y al quedar 9 unidades el sistema reportaba
// $6.699 por unidad. Al llegar a stock 0 saltaba a 0. En la base de producción,
// 71 de 111 ingredientes activos estaban inflados (factor promedio 2,3×, máximo 34×).
//
// LA INVARIANTE
// -------------
// El costo unitario SOLO cambia cuando entra mercancía a un precio distinto.
// Vender, mermar o ajustar a la baja no mueve el costo unitario: saca valor y
// unidades en la misma proporción.
//
// Por eso el valor del inventario se reconstruye siempre desde
// `stock × costoUnitario` y nunca se confía en el `totalPurchaseCost` guardado:
// así el dato se auto-repara en el primer movimiento después de este arreglo.

import { convertQuantity, type ConversionCtx } from './unit-conversion';

export interface StockValuationInput {
  /** Stock antes del movimiento, en unidades de COMPRA. */
  previousStock: number;
  /** Stock después del movimiento, en unidades de COMPRA. */
  newStock: number;
  /** Costo por unidad de compra vigente antes del movimiento. */
  previousGrossUnitCost: number;
  /** Costo por unidad de receta vigente antes del movimiento. */
  previousNetUnitCost: number;
  /**
   * Precio unitario de la mercancía que ENTRA, cuando el movimiento lo trae
   * (compra). Sin él, una entrada se valora al costo vigente y el promedio no
   * se mueve — que es lo correcto para devoluciones y ajustes al alza.
   */
  entryUnitCost?: number | null;
  technicalWastePercentage: number;
  conversion: ConversionCtx;
}

export interface StockValuation {
  totalPurchaseCost: number;
  grossUnitCost: number;
  netUnitCost: number;
  netUsableQuantity: number;
}

export function valueStockAfterMovement(
  input: StockValuationInput,
): StockValuation {
  const {
    previousStock,
    newStock,
    previousGrossUnitCost,
    previousNetUnitCost,
    entryUnitCost,
    technicalWastePercentage,
    conversion,
  } = input;

  const usableRatio = 1 - technicalWastePercentage / 100;
  const netUsableQuantity =
    newStock > 0
      ? convertQuantity(
          newStock,
          conversion.purchaseUnit,
          conversion.recipeUnit,
          conversion,
        ) * usableRatio
      : 0;

  // Un ingrediente agotado NO vale cero por unidad: solo no hay unidades. Se
  // conserva el último costo conocido para que reponer no arranque de cero y
  // para que el costeo de recetas no reporte margen del 100 % durante el quiebre.
  if (newStock <= 0) {
    return {
      totalPurchaseCost: 0,
      grossUnitCost: previousGrossUnitCost,
      netUnitCost: previousNetUnitCost,
      netUsableQuantity: 0,
    };
  }

  const delta = newStock - previousStock;
  const baseValue = Math.max(0, previousStock) * previousGrossUnitCost;

  let totalPurchaseCost: number;
  if (delta >= 0) {
    // Entrada: promedio ponderado entre lo que había y lo que llega.
    const unitValue =
      typeof entryUnitCost === 'number' && entryUnitCost >= 0
        ? entryUnitCost
        : previousGrossUnitCost;
    totalPurchaseCost = baseValue + delta * unitValue;
  } else {
    // Salida: se va valor y unidades en la misma proporción, así que el costo
    // unitario queda EXACTAMENTE igual. Esta línea es el arreglo.
    totalPurchaseCost = newStock * previousGrossUnitCost;
  }

  totalPurchaseCost = Math.max(0, totalPurchaseCost);
  const grossUnitCost = totalPurchaseCost / newStock;
  const netUnitCost =
    netUsableQuantity > 0
      ? totalPurchaseCost / netUsableQuantity
      : previousNetUnitCost;

  return { totalPurchaseCost, grossUnitCost, netUnitCost, netUsableQuantity };
}

/** Lo que hace falta de un ingrediente para valorarlo. */
export interface ValuableIngredient extends ConversionCtx {
  currentStock: number;
  grossUnitCost: number;
  netUnitCost: number;
  technicalWastePercentage: number;
}

/** Atajo para el caso común: valorar un ingrediente que pasa a `newStock`. */
export function valueIngredientAt(
  ingredient: ValuableIngredient,
  newStock: number,
  options: { previousStock?: number; entryUnitCost?: number | null } = {},
): StockValuation {
  return valueStockAfterMovement({
    previousStock: options.previousStock ?? ingredient.currentStock,
    newStock,
    previousGrossUnitCost: ingredient.grossUnitCost,
    previousNetUnitCost: ingredient.netUnitCost,
    entryUnitCost: options.entryUnitCost,
    technicalWastePercentage: ingredient.technicalWastePercentage,
    conversion: ingredient,
  });
}
