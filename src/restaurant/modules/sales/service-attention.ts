/**
 * "Atención de la mesa": quién hizo qué en una venta, a partir de la bitácora
 * (`order_events`). Es la base para que el dueño o el administrador vean quién tomó el
 * pedido, quién lo envió, quién lo entregó y quién cobró (a veces son personas distintas,
 * y a veces lo hace el propio dueño). Función pura: no lee la base.
 *
 * Los eventos anteriores al registro de actor no se inventan: quedan como "sin registro"
 * y `complete` lo avisa.
 */

type EventLike = {
  type: string;
  ticketId?: string | null;
  metadata?: unknown;
  actorId?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
};

export type Person = { id: string | null; name: string; role: string | null };

export type AttentionRow = Person & {
  /** Unidades (tomadas o entregadas) o cantidad de acciones, según el campo. */
  units: number;
};

export type Attention = {
  /** Quién abrió la mesa. */
  openedBy: Person | null;
  /** Mesero asignado a la mesa (campo de la orden), aunque no haya eventos. */
  assignedWaiter: string | null;
  /** Quién tomó cada pedido, con las unidades que agregó. */
  takers: AttentionRow[];
  /** Quién envió a cocina o imprimió la comanda (cantidad de envíos). */
  senders: AttentionRow[];
  /** Quién entregó en la mesa, con las unidades. */
  deliverers: AttentionRow[];
  /** Quién registró el pago. */
  payers: AttentionRow[];
  /** Quién cerró la cuenta. */
  closedBy: Person | null;
  /** false si hay acciones clave sin actor (ventas anteriores al registro). */
  complete: boolean;
};

const personOf = (e: EventLike): Person | null =>
  e.actorName || e.actorId
    ? { id: e.actorId ?? null, name: e.actorName ?? 'Sin nombre', role: e.actorRole ?? null }
    : null;

const keyOf = (p: Person) => p.id ?? `name:${p.name}`;

function tally(
  events: EventLike[],
  weight: (e: EventLike) => number,
): { rows: AttentionRow[]; anonymous: number } {
  const map = new Map<string, AttentionRow>();
  let anonymous = 0;
  for (const e of events) {
    const w = weight(e);
    if (w <= 0) continue;
    const p = personOf(e);
    if (!p) {
      anonymous += w;
      continue;
    }
    const k = keyOf(p);
    const row = map.get(k) ?? { ...p, units: 0 };
    row.units += w;
    map.set(k, row);
  }
  return {
    rows: [...map.values()].sort((a, b) => b.units - a.units),
    anonymous,
  };
}

const meta = (e: EventLike) => (e.metadata ?? {}) as Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function buildAttention(
  events: EventLike[],
  assignedWaiter?: string | null,
): Attention {
  const of = (type: string) => events.filter((e) => e.type === type);

  const opened = of('OPENED')[0];
  const closed = of('CLOSED')[0];

  // Tomar pedido: unidades agregadas (ITEM_ADDED y los aumentos de ITEM_UPDATED).
  const taken = tally(
    events.filter((e) => e.type === 'ITEM_ADDED' || e.type === 'ITEM_UPDATED'),
    (e) => Math.max(0, num(meta(e).deltaQty)),
  );
  const sent = tally(of('SENT_TO_KITCHEN'), () => 1);

  // Entrega: por unidad (ITEM_SERVED). Las comandas marcadas completas con la versión
  // anterior solo tienen SERVED por comanda; se cuentan por comanda para no perderlas.
  const itemServed = of('ITEM_SERVED');
  const ticketsWithItemDetail = new Set(itemServed.map((e) => e.ticketId));
  const delivered = tally(itemServed, (e) => Math.max(0, num(meta(e).deltaQty)));
  const legacy = tally(
    of('SERVED').filter((e) => !ticketsWithItemDetail.has(e.ticketId)),
    () => 1,
  );
  const deliverers = [...delivered.rows];
  for (const row of legacy.rows) {
    const same = deliverers.find((d) => keyOf(d) === keyOf(row));
    if (same) same.units += row.units;
    else deliverers.push(row);
  }
  deliverers.sort((a, b) => b.units - a.units);

  const paid = tally(of('PAYMENT_REGISTERED'), () => 1);

  const complete =
    !!opened && !!personOf(opened) && taken.anonymous === 0 && sent.anonymous === 0 &&
    delivered.anonymous === 0 && legacy.anonymous === 0 && paid.anonymous === 0 &&
    (!closed || !!personOf(closed));

  return {
    openedBy: opened ? personOf(opened) : null,
    assignedWaiter: assignedWaiter ?? null,
    takers: taken.rows,
    senders: sent.rows,
    deliverers,
    payers: paid.rows,
    closedBy: closed ? personOf(closed) : null,
    complete,
  };
}
