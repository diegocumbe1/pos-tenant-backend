import { buildWaiterRanking } from './waiter-ranking';

const ana = { actorId: 'u1', actorName: 'Ana', actorRole: 'WAITER' };
const luis = { actorId: 'u2', actorName: 'Luis', actorRole: 'WAITER' };
const dueno = { actorId: 'u3', actorName: 'Diego', actorRole: 'OWNER' };

const orderOf = (id: string, totalCOP: number, events: object[]) => ({ id, totalCOP, events: events as never });

describe('buildWaiterRanking', () => {
  const orders = [
    // Ana toma y entrega: mesa propia de $100.000
    orderOf('o1', 100000, [
      { type: 'ITEM_ADDED', metadata: { deltaQty: 3 }, ...ana },
      { type: 'ITEM_SERVED', ticketId: 'k', metadata: { deltaQty: 3 }, ...ana },
      { type: 'PAYMENT_REGISTERED', ...dueno },
    ]),
    // Ana toma, Luis entrega: la venta es de Ana, Luis suma su mesa y entregas
    orderOf('o2', 60000, [
      { type: 'ITEM_ADDED', metadata: { deltaQty: 2 }, ...ana },
      { type: 'ITEM_SERVED', ticketId: 'k', metadata: { deltaQty: 2 }, ...luis },
      { type: 'PAYMENT_REGISTERED', ...ana },
    ]),
    // venta anterior al registro
    orderOf('o3', 40000, [{ type: 'OPENED' }, { type: 'ITEM_ADDED', metadata: { deltaQty: 1 } }]),
  ];
  const r = buildWaiterRanking(orders);
  const byName = Object.fromEntries(r.rows.map((x) => [x.name, x]));

  it('cuenta mesas, unidades tomadas y entregadas por persona', () => {
    expect(byName.Ana).toMatchObject({ tables: 2, takenUnits: 5, deliveredUnits: 3, ownTables: 2 });
    expect(byName.Luis).toMatchObject({ tables: 1, takenUnits: 0, deliveredUnits: 2, ownTables: 0 });
  });

  it('la venta se atribuye a quien tomó el pedido, sin duplicarla', () => {
    expect(byName.Ana.salesCOP).toBe(160000);
    expect(byName.Ana.avgTicketCOP).toBe(80000);
    expect(byName.Luis.salesCOP).toBe(0);
    expect(r.rows.reduce((n, x) => n + x.salesCOP, 0)).toBe(160000);
  });

  it('el dueño o admin que cobra aparece, con su rol', () => {
    expect(byName.Diego).toMatchObject({ role: 'OWNER', charges: 1, tables: 0 });
    expect(byName.Ana.charges).toBe(1);
  });

  it('avisa cuántas ventas no tienen registro, sin inventar nombres', () => {
    expect(r.ordersCount).toBe(3);
    expect(r.ordersWithoutRecord).toBe(1);
  });

  it('ordena por mesas atendidas', () => {
    expect(r.rows[0].name).toBe('Ana');
  });

  it('sin ventas: vacío', () => {
    expect(buildWaiterRanking([])).toEqual({ rows: [], ordersCount: 0, ordersWithoutRecord: 0 });
  });
});
