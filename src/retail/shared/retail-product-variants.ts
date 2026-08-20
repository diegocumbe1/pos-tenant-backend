/**
 * Existencias repartidas por valor de opción.
 *
 * Un producto puede señalar UN grupo de sus `options` como el que lleva el
 * inventario (`RetailProduct.stockOptionId`). Cuando lo hace, cada valor de ese
 * grupo se materializa en una fila de `RetailProductVariant` con su propio
 * conteo. Los demás grupos siguen siendo presentación: 6 aromas × 3 colores son
 * 6 filas, no 18.
 *
 * Es opcional y por producto a propósito. En "Mantequilla Corporal" el grupo que
 * divide el inventario es Aromas; en una pijama con color y talla puede no haber
 * ninguno y el stock sigue siendo del producto, como siempre.
 *
 * REGLA CENTRAL: `RetailProduct.stock` sigue siendo el total físico y la fuente
 * de verdad del número que se muestra en todas partes. Las variantes dicen
 * CUÁLES son esas unidades. La diferencia es lo que todavía no se contó por
 * aroma, y se reporta como pendiente en vez de inventarse un reparto.
 */

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RetailProductOption } from './retail-product-options';

export type ProductVariantRow = {
  id: string;
  optionValueId: string;
  label: string;
  sku: string | null;
  stock: number;
  minStock: number;
};

/** Cliente de Prisma dentro de una transacción. */
type Tx = Prisma.TransactionClient;

/**
 * Deja el grupo que reparte en un valor válido.
 *
 * Señalar un grupo que no existe dejaría un producto que dice repartir por algo
 * que nadie configuró: se trata como "no reparte" en vez de fallar, porque el
 * caso típico es que el admin borró el grupo y no volvió a tocar este campo.
 */
export function resolveStockOptionId(
  stockOptionId: string | null | undefined,
  options: RetailProductOption[] | null,
): string | null {
  if (!stockOptionId) return null;
  return (options ?? []).some((option) => option.id === stockOptionId)
    ? stockOptionId
    : null;
}

/**
 * Sincroniza las filas de variante con los valores del grupo que reparte.
 *
 * - Sin grupo señalado: se borran todas y el producto vuelve a contar entero.
 * - Con grupo: una fila por valor. Se crean las que faltan en 0 y se borran las
 *   de valores que ya no existen.
 *
 * NUNCA toca el `stock` de una fila que sobrevive: repartir es un acto explícito
 * del admin (ver `setVariantDistribution`), no un efecto secundario de guardar
 * el producto. Renombrar "Arrurú" no puede mover existencias.
 *
 * Sí actualiza el `label`, que es una copia para que el kardex y el histórico de
 * ventas sigan siendo legibles.
 */
export async function syncProductVariants(
  tx: Tx,
  params: {
    tenantId: string;
    branchId: string;
    productId: string;
    stockOptionId: string | null;
    options: RetailProductOption[] | null;
  },
): Promise<void> {
  const group = params.stockOptionId
    ? (params.options ?? []).find(
        (option) => option.id === params.stockOptionId,
      )
    : undefined;

  if (!group) {
    await tx.retailProductVariant.deleteMany({
      where: { productId: params.productId },
    });
    return;
  }

  const existing = await tx.retailProductVariant.findMany({
    where: { productId: params.productId },
    select: { id: true, optionValueId: true, label: true },
  });
  const byValueId = new Map(existing.map((row) => [row.optionValueId, row]));
  const liveValueIds = new Set(group.values.map((value) => value.id));

  const orphans = existing
    .filter((row) => !liveValueIds.has(row.optionValueId))
    .map((row) => row.id);
  if (orphans.length > 0) {
    await tx.retailProductVariant.deleteMany({
      where: { id: { in: orphans } },
    });
  }

  for (const value of group.values) {
    const current = byValueId.get(value.id);
    if (!current) {
      await tx.retailProductVariant.create({
        data: {
          tenantId: params.tenantId,
          branchId: params.branchId,
          productId: params.productId,
          optionValueId: value.id,
          label: value.label,
          stock: 0,
          minStock: 0,
        },
      });
    } else if (current.label !== value.label) {
      await tx.retailProductVariant.update({
        where: { id: current.id },
        data: { label: value.label },
      });
    }
  }
}

/**
 * Cuántas unidades del total todavía no se han asignado a ningún valor.
 *
 * Nunca negativo: si por algún motivo las variantes suman más que el total, el
 * pendiente es 0 y el descuadre se ve en `isOverAssigned`, que es información
 * para el admin, no un error que deba tumbar una lectura del catálogo.
 */
export function variantStockSummary(
  productStock: number,
  variants: Array<{ stock: number }>,
): { assignedStock: number; unassignedStock: number; isOverAssigned: boolean } {
  const assignedStock = variants.reduce((sum, row) => sum + row.stock, 0);
  return {
    assignedStock,
    unassignedStock: Math.max(0, productStock - assignedStock),
    isOverAssigned: assignedStock > productStock,
  };
}

/**
 * Reparte el total existente entre los valores.
 *
 * NO genera kardex y es correcto que no lo haga: el total físico no cambia, no
 * entró ni salió mercancía de la tienda. Lo único que cambia es saber cuáles de
 * las 11 mantequillas son de Arrurú. Para que entre o salga mercancía está el
 * movimiento de inventario, que sí deja rastro.
 *
 * Por eso mismo la suma no puede superar el total: repartir 15 unidades de un
 * producto del que hay 11 no es un reparto, es un conteo mal hecho, y dejarlo
 * pasar rompería la única garantía de este modelo (el total manda).
 */
export async function setVariantDistribution(
  tx: Tx,
  params: {
    productId: string;
    productName: string;
    productStock: number;
    items: Array<{ variantId: string; stock: number; minStock?: number }>;
  },
): Promise<void> {
  const variants = await tx.retailProductVariant.findMany({
    where: { productId: params.productId },
    select: { id: true, stock: true, label: true },
  });
  if (variants.length === 0) {
    throw new BadRequestException(
      `"${params.productName}" no reparte existencias por opción`,
    );
  }

  const byId = new Map(variants.map((row) => [row.id, row]));
  for (const item of params.items) {
    if (!byId.has(item.variantId)) {
      throw new BadRequestException(
        `La variante ${item.variantId} no pertenece a "${params.productName}"`,
      );
    }
    if (item.stock < 0) {
      throw new BadRequestException(
        `El conteo de "${byId.get(item.variantId)!.label}" no puede ser negativo`,
      );
    }
  }

  // Los valores que no vienen en el request conservan su conteo actual: así se
  // puede corregir un solo aroma sin tener que reenviar todos.
  const nextStockById = new Map(variants.map((row) => [row.id, row.stock]));
  for (const item of params.items) {
    nextStockById.set(item.variantId, item.stock);
  }

  const assigned = [...nextStockById.values()].reduce((a, b) => a + b, 0);
  if (assigned > params.productStock) {
    throw new BadRequestException(
      `El reparto suma ${assigned} unidades pero de "${params.productName}" hay ${params.productStock}. ` +
        `Ajusta el conteo, o registra la entrada en Inventario si de verdad llegó más mercancía.`,
    );
  }

  for (const item of params.items) {
    await tx.retailProductVariant.update({
      where: { id: item.variantId },
      data: {
        stock: item.stock,
        ...(item.minStock === undefined ? {} : { minStock: item.minStock }),
      },
    });
  }
}
