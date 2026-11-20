import { buildAttention } from './service-attention';

type OrderLike = {
  id: string;
  totalCOP: number | null;
  events: Parameters<typeof buildAttention>[0];
};

export type WaiterRow = {
  id: string | null;
  name: string;
  role: string | null;
  /** Mesas en las que tomó pedido o entregó. */
  tables: number;
  /** Unidades que tomó (pedido). */
  takenUnits: number;
  /** Unidades que llevó a la mesa. */
  deliveredUnits: number;
  /** Cuentas que cobró. */
  charges: number;
  /** Mesas en las que fue quien más tomó (a ellas se les atribuye la venta). */
  ownTables: number;
  /** Ventas de esas mesas, en COP. */
  salesCOP: number;
  /** Venta promedio por mesa propia. */
  avgTicketCOP: number;
};

export type WaiterRanking = {
  rows: WaiterRow[];
  /** Ventas del período, con o sin registro de quién atendió. */
  ordersCount: number;
  /** Ventas sin ningún dato de quién atendió (anteriores al registro). */
  ordersWithoutRecord: number;
};

/**
 * Quién atiende más: suma, por persona, lo que hizo en cada venta cerrada del período.
 * Una venta cuenta a quien tomó la mayor parte del pedido (a ella se le atribuye el
 * valor). Si lo tomaron dos personas, el valor NO se reparte ni se duplica: va a quien
 * más unidades tomó; la otra suma sus unidades y su mesa, no la venta.
 */
export function buildWaiterRanking(orders: OrderLike[]): WaiterRanking {
  const map = new Map<string, WaiterRow>();
  const get = (p: { id: string | null; name: string; role: string | null }) => {
    const key = p.id ?? `name:${p.name}`;
    let row = map.get(key);
    if (!row) {
      row = {
        id: p.id, name: p.name, role: p.role, tables: 0, takenUnits: 0,
        deliveredUnits: 0, charges: 0, ownTables: 0, salesCOP: 0, avgTicketCOP: 0,
      };
      map.set(key, row);
    }
    return row;
  };

  let withoutRecord = 0;
  for (const order of orders) {
    const a = buildAttention(order.events);
    const touched = new Set<string>();
    const mark = (p: { id: string | null; name: string }) => touched.add(p.id ?? `name:${p.name}`);

    for (const t of a.takers) { get(t).takenUnits += t.units; mark(t); }
    for (const d of a.deliverers) { get(d).deliveredUnits += d.units; mark(d); }
    for (const c of a.payers) get(c).charges += c.units;

    if (a.takers.length === 0 && a.deliverers.length === 0 && a.payers.length === 0) {
      withoutRecord += 1;
      continue;
    }
    for (const key of touched) {
      const row = [...map.entries()].find(([k]) => k === key)?.[1];
      if (row) row.tables += 1;
    }
    const main = a.takers[0];
    if (main) {
      const row = get(main);
      row.ownTables += 1;
      row.salesCOP += order.totalCOP ?? 0;
    }
  }

  const rows = [...map.values()].map((r) => ({
    ...r,
    avgTicketCOP: r.ownTables > 0 ? Math.round(r.salesCOP / r.ownTables) : 0,
  }));
  rows.sort(
    (a, b) => b.tables - a.tables || b.salesCOP - a.salesCOP || a.name.localeCompare(b.name),
  );
  return { rows, ordersCount: orders.length, ordersWithoutRecord: withoutRecord };
}
