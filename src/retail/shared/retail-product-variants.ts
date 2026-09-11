/**
 * Existencias repartidas por COMBINACIÓN de opciones.
 *
 * Un producto señala en `RetailProduct.stockOptionIds` qué grupos de sus
 * `options` llevan el inventario. Con uno, cada valor se materializa en una fila
 * (6 aromas = 6 filas) y es el comportamiento de siempre. Con varios, se
 * materializa el PRODUCTO CARTESIANO: 3 colores × 5 tallas = 15 filas, una por
 * combinación real. Los grupos que no están en esa lista siguen siendo pura
 * presentación.
 *
 * Es opcional y por producto a propósito. En "Mantequilla Corporal" el grupo que
 * divide el inventario es Aromas; en una pijama con color y talla pueden repartir
 * los dos, o ninguno y el stock sigue siendo del producto.
 *
 * REGLA CENTRAL: `RetailProduct.stock` sigue siendo el total físico y la fuente
 * de verdad del número que se muestra en todas partes. Las variantes dicen
 * CUÁLES son esas unidades. La diferencia es lo que todavía no se contó por
 * aroma, y se reporta como pendiente en vez de inventarse un reparto.
 */

import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RetailProductOption } from './retail-product-options';

export type ProductVariantRow = {
  id: string;
  /** DEPRECADO — ver el schema. Null en combinaciones de varias dimensiones. */
  optionValueId: string | null;
  /** Los valores que forman la combinación, en el orden de `stockOptionIds`. */
  optionValueIds: string[];
  /** Los mismos ids ordenados y unidos por "|". Identidad de la combinación. */
  combinationKey: string;
  label: string;
  sku: string | null;
  stock: number;
  minStock: number;
};

/**
 * Tope de combinaciones por producto.
 *
 * No es una limitación técnica —Postgres aguanta de sobra— sino operativa: un
 * producto con 300 combinaciones no se puede contar en una estantería, y el
 * catálogo que lo contenga pesará de más en cada apertura del mostrador. Si
 * alguien llega acá, casi siempre es que ese producto en realidad son varios.
 */
export const MAX_VARIANT_COMBINATIONS = 200;

/**
 * La identidad de una combinación.
 *
 * Se ORDENA antes de unir, y ese detalle es la garantía del modelo: sin ordenar,
 * (negro,38) y (38,negro) serían dos claves distintas, pasarían el unique las
 * dos y el stock de esa combinación quedaría partido en dos filas sin que nadie
 * lo note.
 */
export function combinationKeyOf(optionValueIds: string[]): string {
  return [...optionValueIds].sort().join('|');
}

/** Cliente de Prisma dentro de una transacción. */
type Tx = Prisma.TransactionClient;

/**
 * Deja los grupos que reparten en valores válidos, conservando el orden pedido.
 *
 * Señalar un grupo que no existe dejaría un producto que dice repartir por algo
 * que nadie configuró: se descarta en vez de fallar, porque el caso típico es que
 * el admin borró el grupo y no volvió a tocar este campo.
 *
 * El ORDEN se respeta porque manda en la etiqueta: [color, talla] produce
 * "Negro · 38" y [talla, color] produce "38 · Negro".
 */
export function resolveStockOptionIds(
  stockOptionIds: string[] | null | undefined,
  options: RetailProductOption[] | null,
): string[] {
  const live = new Set((options ?? []).map((option) => option.id));
  // Deduplicado: el mismo grupo dos veces multiplicaría sus valores por sí mismos.
  return [...new Set(stockOptionIds ?? [])].filter((id) => live.has(id));
}

/** Compatibilidad con el campo viejo mientras conviven los dos. */
export function resolveStockOptionId(
  stockOptionId: string | null | undefined,
  options: RetailProductOption[] | null,
): string | null {
  return (
    resolveStockOptionIds(stockOptionId ? [stockOptionId] : [], options)[0] ??
    null
  );
}

/**
 * El producto cartesiano de los valores de los grupos que reparten.
 *
 * Con un grupo devuelve una entrada por valor —idéntico a lo de siempre—; con
 * varios, una por combinación. Se omiten los grupos sin valores con nombre: un
 * grupo a medio configurar multiplicaría por cero y borraría todas las filas.
 */
export function buildCombinations(
  groups: RetailProductOption[],
): Array<{ optionValueIds: string[]; label: string }> {
  const usable = groups
    .map((group) => group.values.filter((value) => value.label.trim()))
    .filter((values) => values.length > 0);
  if (usable.length === 0) return [];

  let combos: Array<{ optionValueIds: string[]; label: string }> = [
    { optionValueIds: [], label: '' },
  ];
  for (const values of usable) {
    const next: typeof combos = [];
    for (const combo of combos) {
      for (const value of values) {
        next.push({
          optionValueIds: [...combo.optionValueIds, value.id],
          // " · " es el separador que ya usa el mostrador para mostrar la variante.
          label: combo.label ? `${combo.label} · ${value.label}` : value.label,
        });
      }
    }
    combos = next;
  }
  return combos;
}

/**
 * Sincroniza las filas de variante con las combinaciones vigentes.
 *
 * - Sin grupos que repartan: se borran todas y el producto vuelve a contar entero.
 * - Con grupos: una fila por combinación. Se crean las que faltan en 0 y se
 *   borran las de combinaciones que ya no existen.
 *
 * NUNCA toca el `stock` de una fila que sobrevive: repartir es un acto explícito
 * del admin (ver `setVariantDistribution`), no un efecto secundario de guardar
 * el producto. Renombrar "Arrurú" no puede mover existencias — por eso la
 * identidad es `combinationKey` (ids) y no la etiqueta.
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
    stockOptionIds: string[];
    options: RetailProductOption[] | null;
  },
): Promise<void> {
  const byId = new Map(
    (params.options ?? []).map((option) => [option.id, option]),
  );
  const groups = params.stockOptionIds
    .map((id) => byId.get(id))
    .filter((group): group is RetailProductOption => Boolean(group));

  const combos = groups.length > 0 ? buildCombinations(groups) : [];

  if (combos.length === 0) {
    await tx.retailProductVariant.deleteMany({
      where: { productId: params.productId },
    });
    return;
  }

  // El tope se valida ANTES de escribir nada: fallar a mitad dejaría el producto
  // con un reparto incompleto y el total descuadrado contra la suma de sus filas.
  if (combos.length > MAX_VARIANT_COMBINATIONS) {
    throw new BadRequestException(
      `Ese reparto son ${combos.length} combinaciones y el máximo es ${MAX_VARIANT_COMBINATIONS}. ` +
        'Con tantas, contarlas en la estantería es inviable: separa el producto en varios.',
    );
  }

  const existing = await tx.retailProductVariant.findMany({
    where: { productId: params.productId },
    select: { id: true, combinationKey: true, label: true },
  });
  const byKey = new Map(existing.map((row) => [row.combinationKey, row]));
  const liveKeys = new Set(
    combos.map((combo) => combinationKeyOf(combo.optionValueIds)),
  );

  const orphans = existing
    .filter((row) => !liveKeys.has(row.combinationKey))
    .map((row) => row.id);
  if (orphans.length > 0) {
    await tx.retailProductVariant.deleteMany({
      where: { id: { in: orphans } },
    });
  }

  for (const combo of combos) {
    const key = combinationKeyOf(combo.optionValueIds);
    const current = byKey.get(key);
    if (!current) {
      await tx.retailProductVariant.create({
        data: {
          tenantId: params.tenantId,
          branchId: params.branchId,
          productId: params.productId,
          optionValueIds: combo.optionValueIds,
          combinationKey: key,
          // Se sigue llenando mientras la columna vieja exista: un rollback del
          // despliegue tiene que encontrar la fila utilizable.
          optionValueId:
            combo.optionValueIds.length === 1 ? combo.optionValueIds[0] : null,
          label: combo.label,
          stock: 0,
          minStock: 0,
        },
      });
    } else if (current.label !== combo.label) {
      await tx.retailProductVariant.update({
        where: { id: current.id },
        data: { label: combo.label },
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
    items: Array<{
      /** Identifica la fila por su id, o por el valor de opción al que pertenece. */
      variantId?: string;
      optionValueId?: string;
      stock: number;
      minStock?: number;
      /**
       * Lo que el cliente creía que había cuando calculó `stock`.
       *
       * ES LO QUE HACE SEGURO MANDAR UN ABSOLUTO. La pantalla suma "lo que
       * llegó" sobre lo que tenía cargado, así que manda un total calculado
       * contra una foto que puede estar vieja: si entre medias entró mercancía
       * por un pedido, o alguien repartió desde otro equipo, ese total pisaría
       * el cambio ajeno sin que nadie se entere. Con esto el servidor compara
       * contra lo que hay de verdad y rechaza en vez de sobrescribir.
       *
       * Omitirlo mantiene el comportamiento de antes (pisar), que es lo que
       * necesita quien de verdad quiere fijar un conteo pase lo que pase.
       */
      expectedStock?: number;
    }>;
  },
): Promise<Array<{ variantId: string; delta: number }>> {
  const variants = await tx.retailProductVariant.findMany({
    where: { productId: params.productId },
    select: { id: true, optionValueId: true, stock: true, label: true },
  });
  if (variants.length === 0) {
    throw new BadRequestException(
      `"${params.productName}" no reparte existencias por opción`,
    );
  }

  const byId = new Map(variants.map((row) => [row.id, row]));
  const byOptionValueId = new Map(
    variants.map((row) => [row.optionValueId, row]),
  );

  // Se resuelve cada renglón a una fila real ANTES de tocar nada: si un id no
  // corresponde, el reparto entero se rechaza en vez de aplicarse a medias.
  const resolved = params.items.map((item) => {
    const row = item.variantId
      ? byId.get(item.variantId)
      : item.optionValueId
        ? byOptionValueId.get(item.optionValueId)
        : undefined;

    if (!row) {
      throw new BadRequestException(
        `Uno de los valores del reparto no pertenece a "${params.productName}"`,
      );
    }
    if (item.stock < 0) {
      throw new BadRequestException(
        `El conteo de "${row.label}" no puede ser negativo`,
      );
    }
    if (item.expectedStock !== undefined && item.expectedStock !== row.stock) {
      throw new ConflictException(
        `"${row.label}" cambió mientras editabas: tenías ${item.expectedStock} y ahora hay ${row.stock}. ` +
          `Vuelve a abrir el reparto para no pisar lo que se movió.`,
      );
    }
    return { row, stock: item.stock, minStock: item.minStock };
  });

  // Los valores que no vienen en el request conservan su conteo actual: así se
  // puede corregir un solo aroma sin tener que reenviar todos.
  const nextStockById = new Map(variants.map((row) => [row.id, row.stock]));
  for (const item of resolved) {
    nextStockById.set(item.row.id, item.stock);
  }

  const assigned = [...nextStockById.values()].reduce((a, b) => a + b, 0);
  if (assigned > params.productStock) {
    throw new BadRequestException(
      `El reparto suma ${assigned} unidades pero de "${params.productName}" hay ${params.productStock}. ` +
        `Ajusta el conteo, o registra la entrada en Inventario si de verdad llegó más mercancía.`,
    );
  }

  // Cuánto se movió cada fila. Lo necesita quien llama para mover los saldos
  // por bodega: repartir traslada unidades del renglón "sin repartir" al del
  // aroma, y esas dos filas viven en `RetailStockBalance`.
  const deltas: Array<{ variantId: string; delta: number }> = [];

  for (const item of resolved) {
    await tx.retailProductVariant.update({
      where: { id: item.row.id },
      data: {
        stock: item.stock,
        ...(item.minStock === undefined ? {} : { minStock: item.minStock }),
      },
    });
    if (item.stock !== item.row.stock) {
      deltas.push({
        variantId: item.row.id,
        delta: item.stock - item.row.stock,
      });
    }
  }

  return deltas;
}
