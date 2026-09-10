/**
 * [VERTICAL_RETAIL] Dónde está físicamente la mercancía.
 *
 * POR QUÉ EXISTE. El inventario sabía CUÁNTO hay y no DÓNDE está. Para una
 * tienda con un solo estante da igual; para una que tiene producto en su bodega
 * y en tres sitios de terceros, "¿dónde busco la mantequilla de maracuyá?" no
 * tenía respuesta y tocaba llamar a preguntar.
 *
 * ES EXHIBICIÓN, NO CONSIGNACIÓN. Llevar mercancía donde Nia no es venderla ni
 * prestarla: no mueve plata, ni el stock total, ni finanzas, ni el costo. Solo
 * cambia el renglón que dice dónde está.
 *
 * LAS DOS REGLAS QUE ORDENAN TODO ESTE ARCHIVO:
 *
 *   1. `RetailProduct.stock` SIGUE MANDANDO. Es el total y la fuente de verdad
 *      de todas las pantallas. Los saldos por bodega lo reparten, no lo
 *      reemplazan, y su suma tiene que darlo. Este archivo nunca toca el total:
 *      quien mueve el total es el punto de escritura que llama, y aquí solo se
 *      reparte el mismo delta que ya se aplicó allá.
 *
 *   2. NUNCA BLOQUEA. Ningún saldo por bodega puede impedir una venta, una
 *      devolución ni un ajuste. Cuando una salida no cabe donde se pidió, se
 *      resuelve —tomando de donde sí hay— y en el peor caso se deja negativo en
 *      la principal. Ese negativo es un dato útil: significa que el conteo está
 *      desactualizado, no que el sistema se equivocó.
 */

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** Cliente de Prisma dentro de una transacción. */
type Tx = Prisma.TransactionClient;

export type StockScope = {
  tenantId: string;
  branchId: string;
};

/** La llave de un saldo: qué producto, de qué aroma, en qué sitio. */
export type BalanceKey = {
  locationId: string;
  productId: string;
  variantId?: string | null;
};

/**
 * La bodega principal de la tienda, creándola si todavía no existe.
 *
 * TODO NACE EN PRINCIPAL. Una tienda que nunca abrió la pantalla de bodegas
 * igual necesita un sitio donde poner su mercancía, y ese sitio tiene que
 * existir antes de la primera venta —no cuando al dueño se le ocurra—, o el
 * primer movimiento se quedaría sin dónde restar.
 */
export async function ensureDefaultLocation(
  tx: Tx,
  scope: StockScope,
): Promise<{ id: string; name: string }> {
  const existing = await tx.retailStockLocation.findFirst({
    where: {
      tenantId: scope.tenantId,
      branchId: scope.branchId,
      isDefault: true,
    },
    select: { id: true, name: true },
  });
  if (existing) return existing;

  // El id derivado es el mismo que sembró la migración: si esto corre en una
  // tienda ya migrada, cae en el registro que ya estaba en vez de duplicarlo.
  return tx.retailStockLocation.create({
    data: {
      id: `loc_${scope.tenantId}_${scope.branchId}`,
      tenantId: scope.tenantId,
      branchId: scope.branchId,
      name: 'Bodega principal',
      isDefault: true,
      sortOrder: 0,
    },
    select: { id: true, name: true },
  });
}

/**
 * Valida que una bodega elegida a mano sea de esta tienda, o cae en la
 * principal. Un `locationId` de otra tienda se rechaza; uno vacío no es un
 * error, es "no me dijeron nada".
 */
export async function resolveLocation(
  tx: Tx,
  scope: StockScope,
  locationId: string | null | undefined,
): Promise<string> {
  if (!locationId) return (await ensureDefaultLocation(tx, scope)).id;

  const location = await tx.retailStockLocation.findFirst({
    where: {
      id: locationId,
      tenantId: scope.tenantId,
      branchId: scope.branchId,
    },
    select: { id: true },
  });
  if (!location) {
    throw new BadRequestException(
      'La bodega indicada no existe en esta tienda',
    );
  }
  return location.id;
}

/**
 * Suma `delta` al saldo de una bodega, creando la fila si es la primera vez.
 *
 * NO VALIDA QUE ALCANCE, a propósito (regla 2). Quien decide de dónde sacar es
 * `pickLocationsForOut`; para cuando se llega aquí la decisión ya se tomó y el
 * total del producto ya se movió. Frenar en este punto dejaría el total movido
 * y el reparto sin mover, que es peor que un saldo negativo.
 */
export async function applyBalanceDelta(
  tx: Tx,
  scope: StockScope,
  key: BalanceKey,
  delta: number,
): Promise<void> {
  if (delta === 0) return;

  // findFirst + update/create en vez de upsert: la unicidad de la fila del
  // producto entero la da un índice PARCIAL (`variantId IS NULL`), y un upsert
  // por llave compuesta no puede apuntar a un índice parcial.
  const existing = await tx.retailStockBalance.findFirst({
    where: {
      locationId: key.locationId,
      productId: key.productId,
      variantId: key.variantId ?? null,
    },
    select: { id: true },
  });

  if (existing) {
    await tx.retailStockBalance.update({
      where: { id: existing.id },
      data: { qty: { increment: delta } },
    });
    return;
  }

  await tx.retailStockBalance.create({
    data: {
      tenantId: scope.tenantId,
      branchId: scope.branchId,
      locationId: key.locationId,
      productId: key.productId,
      variantId: key.variantId ?? null,
      qty: delta,
    },
  });
}

/** Lo que hay de un producto (o de un aroma) en cada sitio, de mayor a menor. */
export async function balancesFor(
  tx: Tx,
  scope: StockScope,
  productId: string,
  variantId?: string | null,
): Promise<
  Array<{
    locationId: string;
    locationName: string;
    isDefault: boolean;
    qty: number;
  }>
> {
  const rows = await tx.retailStockBalance.findMany({
    where: {
      tenantId: scope.tenantId,
      branchId: scope.branchId,
      productId,
      variantId: variantId ?? null,
    },
    include: {
      location: {
        select: { id: true, name: true, isDefault: true, isActive: true },
      },
    },
  });

  return rows
    .filter((row) => row.location.isActive)
    .map((row) => ({
      locationId: row.location.id,
      locationName: row.location.name,
      isDefault: row.location.isDefault,
      qty: row.qty,
    }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.qty - a.qty);
}

export type OutAllocation = { locationId: string; quantity: number };

/**
 * De qué bodega(s) sale una cantidad. LA REGLA DE ORO de todo el módulo.
 *
 * El orden importa y no es negociable:
 *
 *   1. Si el cajero eligió una bodega, sale de esa. Punto. Aunque quede
 *      negativa: eligió a mano y sabe algo que el sistema no.
 *   2. Si hay en la principal, sale de la principal EN SILENCIO. Es el 95% de
 *      las ventas y no puede costar un clic de más.
 *   3. Si no hay en la principal, se reparte entre los sitios que SÍ tienen, de
 *      mayor a menor. Así el saldo de cada uno queda bien solo, sin recontar y
 *      sin quedar en negativo.
 *   4. Si no hay en ningún lado, sale de la principal y queda negativa. La venta
 *      nunca se bloquea.
 *
 * El paso 3 es lo que hace que el sistema no tenga que preguntar casi nunca: la
 * UI sí ofrece elegir cuando en la principal no hay, pero si el cajero no toca
 * nada, esto ya reparte bien.
 */
export async function pickLocationsForOut(
  tx: Tx,
  scope: StockScope,
  args: {
    productId: string;
    variantId?: string | null;
    quantity: number;
    /** Bodega elegida a mano en la pantalla. */
    preferredLocationId?: string | null;
  },
): Promise<OutAllocation[]> {
  const { quantity } = args;
  if (quantity <= 0) return [];

  const defaultLocation = await ensureDefaultLocation(tx, scope);

  if (args.preferredLocationId) {
    const locationId = await resolveLocation(
      tx,
      scope,
      args.preferredLocationId,
    );
    return [{ locationId, quantity }];
  }

  const balances = await balancesFor(tx, scope, args.productId, args.variantId);
  const atDefault = balances.find(
    (row) => row.locationId === defaultLocation.id,
  );

  if ((atDefault?.qty ?? 0) >= quantity) {
    return [{ locationId: defaultLocation.id, quantity }];
  }

  // Se reparte de mayor a menor entre lo que hay, empezando por la principal.
  const allocations: OutAllocation[] = [];
  let pending = quantity;
  for (const row of balances) {
    if (pending <= 0) break;
    if (row.qty <= 0) continue;
    const take = Math.min(row.qty, pending);
    allocations.push({ locationId: row.locationId, quantity: take });
    pending -= take;
  }

  // Lo que no alcanzó en ningún lado se lo come la principal, en negativo.
  if (pending > 0) {
    const existing = allocations.find(
      (a) => a.locationId === defaultLocation.id,
    );
    if (existing) existing.quantity += pending;
    else
      allocations.push({ locationId: defaultLocation.id, quantity: pending });
  }

  return allocations;
}

/**
 * Reparte una SALIDA por bodegas y devuelve de dónde salió.
 *
 * El total del producto lo movió quien llama; aquí solo se descuenta el mismo
 * número del sitio correcto. Devuelve la bodega principal de la salida —la que
 * más unidades puso— para que la línea de la venta pueda decir de dónde salió
 * sin inventar una fila por bodega.
 */
export async function allocateOut(
  tx: Tx,
  scope: StockScope,
  args: {
    productId: string;
    variantId?: string | null;
    quantity: number;
    preferredLocationId?: string | null;
  },
): Promise<{ allocations: OutAllocation[]; primaryLocationId: string | null }> {
  const allocations = await pickLocationsForOut(tx, scope, args);

  for (const allocation of allocations) {
    await applyBalanceDelta(
      tx,
      scope,
      {
        locationId: allocation.locationId,
        productId: args.productId,
        variantId: args.variantId ?? null,
      },
      -allocation.quantity,
    );
  }

  const primary = allocations.reduce<OutAllocation | null>(
    (best, current) =>
      !best || current.quantity > best.quantity ? current : best,
    null,
  );
  return { allocations, primaryLocationId: primary?.locationId ?? null };
}

/**
 * Registra una ENTRADA en una bodega. Sin bodega elegida entra a la principal:
 * la mercancía que llega sin decir dónde se guarda, se guarda en la casa.
 */
export async function allocateIn(
  tx: Tx,
  scope: StockScope,
  args: {
    productId: string;
    variantId?: string | null;
    quantity: number;
    locationId?: string | null;
  },
): Promise<string> {
  const locationId = await resolveLocation(tx, scope, args.locationId);
  if (args.quantity !== 0) {
    await applyBalanceDelta(
      tx,
      scope,
      {
        locationId,
        productId: args.productId,
        variantId: args.variantId ?? null,
      },
      args.quantity,
    );
  }
  return locationId;
}

/**
 * El reparto por bodegas de un delta con signo, para los puntos de escritura que
 * no saben de antemano si suman o restan (un ajuste, una anulación).
 */
export async function applySignedDelta(
  tx: Tx,
  scope: StockScope,
  args: {
    productId: string;
    variantId?: string | null;
    /** Firmado: positivo entra, negativo sale. */
    delta: number;
    locationId?: string | null;
  },
): Promise<string | null> {
  if (args.delta === 0) return null;

  if (args.delta > 0) {
    return allocateIn(tx, scope, {
      productId: args.productId,
      variantId: args.variantId,
      quantity: args.delta,
      locationId: args.locationId,
    });
  }

  const { primaryLocationId } = await allocateOut(tx, scope, {
    productId: args.productId,
    variantId: args.variantId,
    quantity: -args.delta,
    preferredLocationId: args.locationId,
  });
  return primaryLocationId;
}
