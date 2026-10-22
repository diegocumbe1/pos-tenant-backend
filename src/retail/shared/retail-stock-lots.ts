/**
 * [VERTICAL_RETAIL] Cuándo vence la mercancía: lotes por fecha.
 *
 * Ver docs/PLAN_RETAIL_AJUSTES_OCTUBRE_2026.md §1 (pos-system).
 *
 * MISMA FILOSOFÍA QUE LAS BODEGAS (`retail-stock-locations.ts`). Los saldos por
 * bodega reparten el total del producto; los lotes reparten el saldo de una
 * bodega por fecha de vencimiento. Ninguno reemplaza al de arriba, y ninguno
 * bloquea: lo que no tiene lote es "sin fecha".
 *
 * TODO PASA POR `applyBalanceDelta`. Cada vez que un saldo baja, los lotes de
 * esa misma llave (bodega × producto × aroma) se consumen del que vence antes
 * (FEFO). Cada vez que sube, la entrada dice qué hacer con los lotes:
 *
 *   - `dated`   → mercancía nueva con fecha: va a ese lote.
 *   - `carry`   → la otra mitad de un traslado o un reparto: las MISMAS fechas
 *                 que salieron del origen entran al destino.
 *   - `restore` → una anulación o devolución: la unidad vuelve al lote del que
 *                 salió (ver `restoreLots`).
 *   - nada      → entra "sin fecha", que es como funcionaba todo antes.
 *
 * Un producto que no vence nunca tiene lotes, así que el consumo es una sola
 * consulta indexada que vuelve vacía.
 */

import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

type Scope = { tenantId: string; branchId: string };

type LotKey = {
  locationId: string;
  productId: string;
  variantId?: string | null;
};

/** Lo que salió de un lote en un consumo, para poder llevarlo a otra parte. */
export type LotTake = {
  lotId: string;
  expiresOn: Date;
  lotCode: string | null;
  quantity: number;
};

/**
 * Lo que el vendedor dijo que tomó del estante: N unidades de este lote, o N
 * "sin fecha" (`lotId` null). Lo que no cubren las elecciones sale por FEFO.
 */
export type LotPick = { lotId: string | null; qty: number };

/**
 * De qué fecha salió cada unidad de una línea de venta o de una entrega. Se
 * guarda en la línea (JSON) para que anular o devolver la regrese a SU lote, y
 * para que el histórico diga qué fecha se vendió.
 *
 * `lotId` null = salió "sin fecha". Si el vendedor anotó la fecha que traía el
 * empaque, va en `expiresOn` con `noted: true`: queda en la venta y NO toca el
 * inventario (decisión de Diego: "solo registrarla").
 */
export type LotAllocation = {
  lotId: string | null;
  expiresOn: string | null;
  qty: number;
  noted?: boolean;
};

/**
 * Qué hacer con los lotes cuando un saldo cambia.
 *
 * Al SUBIR: `dated`, `carry`, `restore`, `exact`.
 * Al BAJAR: `undated` (sale de lo "sin fecha", no consume lotes) y `pick` (lo
 * que el vendedor eligió primero, el resto por FEFO). Sin nada, baja por FEFO.
 */
export type LotEntry =
  | { kind: 'dated'; expiresOn: string; lotCode?: string | null }
  | { kind: 'carry'; takes: LotTake[] }
  | { kind: 'restore' }
  | { kind: 'exact'; allocations: Array<{ lotId: string | null; qty: number }> }
  | { kind: 'undated' }
  | { kind: 'pick'; picks: LotPick[] };

/**
 * "2026-12-12" → la fecha que guarda una columna `@db.Date`.
 *
 * Medianoche UTC y no hora Colombia a propósito: Postgres guarda solo el día, y
 * Prisma lo lee y lo escribe como medianoche UTC. Cualquier otra hora correría
 * el día al pasar por el driver.
 */
export function lotDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** La fecha de un lote como "2026-12-12", sin pasar por la zona horaria. */
export function lotDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function keyWhere(scope: Scope, key: LotKey) {
  return {
    tenantId: scope.tenantId,
    branchId: scope.branchId,
    locationId: key.locationId,
    productId: key.productId,
    variantId: key.variantId ?? null,
  };
}

/**
 * Descuenta `quantity` de los lotes de una llave, del que vence antes al que
 * vence después. Lo que no alcanza a cubrir salía de "sin fecha" y no se anota.
 */
export async function consumeLots(
  tx: Tx,
  scope: Scope,
  key: LotKey,
  quantity: number,
  /**
   * Lo que el vendedor eligió. Se respeta primero y sin discutir: él tiene la
   * unidad en la mano. Un lote que ya no alcanza (otro lo vendió mientras
   * tanto) aporta lo que tenga y el resto cae al FEFO. Nunca bloquea.
   */
  picks?: LotPick[],
): Promise<LotTake[]> {
  if (quantity <= 0) return [];
  const takes: LotTake[] = [];
  let left = quantity;

  for (const pick of picks ?? []) {
    if (left <= 0 || !pick.lotId || pick.qty <= 0) continue;
    const lot = await tx.retailStockLot.findFirst({
      where: { id: pick.lotId, ...keyWhere(scope, key), qty: { gt: 0 } },
      select: { id: true, qty: true, expiresOn: true, lotCode: true },
    });
    if (!lot) continue;
    const take = Math.min(lot.qty, pick.qty, left);
    await tx.retailStockLot.update({
      where: { id: lot.id },
      data: { qty: { decrement: take } },
    });
    takes.push({
      lotId: lot.id,
      expiresOn: lot.expiresOn,
      lotCode: lot.lotCode,
      quantity: take,
    });
    left -= take;
  }
  // Las que eligió "sin fecha" no tocan ningún lote.
  const undatedPicked = (picks ?? [])
    .filter((pick) => !pick.lotId)
    .reduce((sum, pick) => sum + pick.qty, 0);
  left = Math.max(0, left - undatedPicked);
  if (left <= 0) return takes;

  const lots = await tx.retailStockLot.findMany({
    where: { ...keyWhere(scope, key), qty: { gt: 0 } },
    orderBy: [{ expiresOn: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, qty: true, expiresOn: true, lotCode: true },
  });

  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(lot.qty, left);
    await tx.retailStockLot.update({
      where: { id: lot.id },
      data: { qty: { decrement: take } },
    });
    takes.push({
      lotId: lot.id,
      expiresOn: lot.expiresOn,
      lotCode: lot.lotCode,
      quantity: take,
    });
    left -= take;
  }
  return takes;
}

/** Suma unidades NUEVAS a un lote de esa fecha, creándolo si no existe. */
async function addToLot(
  tx: Tx,
  scope: Scope,
  key: LotKey,
  expiresOn: Date,
  lotCode: string | null,
  quantity: number,
) {
  if (quantity <= 0) return;
  const existing = await tx.retailStockLot.findFirst({
    where: { ...keyWhere(scope, key), expiresOn, lotCode },
    select: { id: true },
  });
  if (existing) {
    await tx.retailStockLot.update({
      where: { id: existing.id },
      data: {
        qty: { increment: quantity },
        receivedQty: { increment: quantity },
      },
    });
    return;
  }
  await tx.retailStockLot.create({
    data: {
      ...keyWhere(scope, key),
      expiresOn,
      lotCode,
      qty: quantity,
      receivedQty: quantity,
    },
  });
}

/**
 * Devuelve unidades a los lotes de los que salieron.
 *
 * No se guarda de qué lote salió cada venta: se reconstruye. Los lotes no se
 * borran al quedar en 0 y `receivedQty − qty` dice cuánto se consumió de cada
 * uno. El consumo va del que vence antes al que vence después, así que la
 * última unidad que salió es la del lote más tardío que tiene hueco: se
 * rellena en ese orden, el inverso exacto del FEFO.
 *
 * Es exacto para lo normal —se anula la venta de hace un rato— y razonable en
 * lo raro (anular una venta vieja después de otras): la unidad vuelve a un lote
 * real de esa llave, nunca a una fecha inventada. Lo que no cabe en ningún
 * hueco entra "sin fecha".
 */
async function restoreLots(
  tx: Tx,
  scope: Scope,
  key: LotKey,
  quantity: number,
) {
  if (quantity <= 0) return;
  const lots = await tx.retailStockLot.findMany({
    where: keyWhere(scope, key),
    orderBy: [{ expiresOn: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, qty: true, receivedQty: true },
  });
  let left = quantity;
  for (const lot of lots) {
    if (left <= 0) break;
    const room = lot.receivedQty - lot.qty;
    if (room <= 0) continue;
    const give = Math.min(room, left);
    await tx.retailStockLot.update({
      where: { id: lot.id },
      data: { qty: { increment: give } },
    });
    left -= give;
  }
}

/**
 * Devuelve unidades a los lotes EXACTOS de los que salieron, según lo que la
 * venta guardó. Nunca por encima de lo consumido de cada lote (`receivedQty −
 * qty`): una devolución parcial no puede inflar un lote. Lo que no cabe, o lo
 * que salió "sin fecha", vuelve "sin fecha".
 */
async function restoreExact(
  tx: Tx,
  scope: Scope,
  key: LotKey,
  quantity: number,
  allocations: Array<{ lotId: string | null; qty: number }>,
) {
  let left = quantity;
  for (const allocation of allocations) {
    if (left <= 0) break;
    if (!allocation.lotId) continue;
    const lot = await tx.retailStockLot.findFirst({
      where: { id: allocation.lotId, ...keyWhere(scope, key) },
      select: { id: true, qty: true, receivedQty: true },
    });
    if (!lot) continue;
    const give = Math.min(allocation.qty, lot.receivedQty - lot.qty, left);
    if (give <= 0) continue;
    await tx.retailStockLot.update({
      where: { id: lot.id },
      data: { qty: { increment: give } },
    });
    left -= give;
  }
}

/**
 * Arma el registro de una salida: lo que salió de lotes y lo que salió "sin
 * fecha" (con la fecha anotada por el vendedor, si la dio).
 */
export function buildAllocations(
  takes: LotTake[],
  quantity: number,
  notedDays: Array<{ qty: number; expiresOn: string }> = [],
): LotAllocation[] {
  const allocations: LotAllocation[] = takes.map((take) => ({
    lotId: take.lotId,
    expiresOn: lotDay(take.expiresOn),
    qty: take.quantity,
  }));
  let undated = quantity - takes.reduce((sum, take) => sum + take.quantity, 0);
  for (const noted of notedDays) {
    if (undated <= 0) break;
    const qty = Math.min(noted.qty, undated);
    allocations.push({
      lotId: null,
      expiresOn: noted.expiresOn,
      qty,
      noted: true,
    });
    undated -= qty;
  }
  if (undated > 0) {
    allocations.push({ lotId: null, expiresOn: null, qty: undated });
  }
  return allocations;
}

/**
 * Reparte el registro de una llave entre las líneas que la comparten, en orden
 * y por cantidad. Casi siempre es una línea por llave; dos líneas del mismo
 * sabor en una venta son raras, y este reparto las deja consistentes.
 */
export function splitAllocations(
  allocations: LotAllocation[],
  quantities: number[],
): LotAllocation[][] {
  const pool = allocations.map((allocation) => ({ ...allocation }));
  return quantities.map((quantity) => {
    const mine: LotAllocation[] = [];
    let left = quantity;
    for (const allocation of pool) {
      if (left <= 0) break;
      if (allocation.qty <= 0) continue;
      const qty = Math.min(allocation.qty, left);
      mine.push({ ...allocation, qty });
      allocation.qty -= qty;
      left -= qty;
    }
    return mine;
  });
}

/** Lee el JSON guardado en una línea; cualquier cosa rara cuenta como vacío. */
export function readAllocations(value: unknown): LotAllocation[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is LotAllocation =>
      typeof row === 'object' &&
      row !== null &&
      typeof (row as LotAllocation).qty === 'number',
  );
}

/** Aplica una entrada a los lotes de una llave. */
export async function receiveLots(
  tx: Tx,
  scope: Scope,
  key: LotKey,
  quantity: number,
  entry: LotEntry,
) {
  if (quantity <= 0) return;
  switch (entry.kind) {
    case 'dated':
      await addToLot(
        tx,
        scope,
        key,
        lotDate(entry.expiresOn),
        entry.lotCode?.trim() || null,
        quantity,
      );
      return;
    case 'carry': {
      // Nunca más de lo que de verdad entró: si el origen tenía menos lotes
      // que unidades, el resto llega "sin fecha", igual que salió.
      let left = quantity;
      for (const take of entry.takes) {
        if (left <= 0) break;
        const give = Math.min(take.quantity, left);
        await addToLot(tx, scope, key, take.expiresOn, take.lotCode, give);
        left -= give;
      }
      return;
    }
    case 'restore':
      await restoreLots(tx, scope, key, quantity);
      return;
    case 'exact':
      await restoreExact(tx, scope, key, quantity, entry.allocations);
      return;
    case 'undated':
    case 'pick':
      // Solo tienen sentido al bajar: aquí entra sin fecha.
      return;
  }
}
