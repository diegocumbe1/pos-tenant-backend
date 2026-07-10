import { BadRequestException } from '@nestjs/common';

// Conversión de unidades entre compra y receta.
//
// Dos mecanismos:
//  1. Conversión física automática dentro de una misma dimensión (masa: g/kg/lb,
//     volumen: ml/L). Ej: 1 kg = 1000 g.
//  2. Factor manual `purchaseToRecipeFactor` para unidades de conteo/empaque que
//     no tienen equivalencia física fija. Ej: 1 paquete = 10 unidades. El factor
//     se define SIEMPRE como "cuántas unidades de receta trae 1 unidad de compra".
//
// El factor solo aplica entre la unidad de compra y la de receta del ingrediente,
// por eso `convertQuantity` recibe el contexto del ingrediente para orientarse.

const GRAMS_PER_UNIT: Record<string, number> = {
  g: 1,
  kg: 1000,
  lb: 453.59237,
};
const ML_PER_UNIT: Record<string, number> = { ml: 1, L: 1000 };

export interface ConversionCtx {
  purchaseUnit: string;
  recipeUnit: string;
  purchaseToRecipeFactor?: number | null;
}

/** true si `from`→`to` se puede convertir por dimensión física (sin factor). */
export function isPhysicallyConvertible(from: string, to: string): boolean {
  if (from === to) return true;
  if (from in GRAMS_PER_UNIT && to in GRAMS_PER_UNIT) return true;
  if (from in ML_PER_UNIT && to in ML_PER_UNIT) return true;
  return false;
}

export function convertQuantity(
  quantity: number,
  from: string,
  to: string,
  ctx?: ConversionCtx,
): number {
  if (from === to) return quantity;

  if (from in GRAMS_PER_UNIT && to in GRAMS_PER_UNIT) {
    return (quantity * GRAMS_PER_UNIT[from]) / GRAMS_PER_UNIT[to];
  }
  if (from in ML_PER_UNIT && to in ML_PER_UNIT) {
    return (quantity * ML_PER_UNIT[from]) / ML_PER_UNIT[to];
  }

  // Factor manual compra↔receta (ej: paquete↔unidad).
  const factor = ctx?.purchaseToRecipeFactor;
  if (ctx && typeof factor === 'number' && factor > 0) {
    if (from === ctx.purchaseUnit && to === ctx.recipeUnit) {
      return quantity * factor;
    }
    if (from === ctx.recipeUnit && to === ctx.purchaseUnit) {
      return quantity / factor;
    }
  }

  throw new BadRequestException(`Incompatible units: ${from} -> ${to}`);
}

/**
 * Valida que compra→receta sea convertible. Si no hay conversión física y
 * falta el factor, exige capturarlo con un mensaje accionable.
 */
export function assertCompatibleUnits(
  purchaseUnit: string,
  recipeUnit: string,
  purchaseToRecipeFactor?: number | null,
): void {
  if (isPhysicallyConvertible(purchaseUnit, recipeUnit)) return;

  if (typeof purchaseToRecipeFactor === 'number' && purchaseToRecipeFactor > 0) {
    return;
  }

  throw new BadRequestException(
    `Indica cuántas ${recipeUnit} trae una ${purchaseUnit} (campo purchaseToRecipeFactor).`,
  );
}
