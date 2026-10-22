import { Prisma } from '@prisma/client';
import {
  buildAllocations,
  consumeLots,
  lotDate,
  lotDay,
  receiveLots,
  splitAllocations,
} from './retail-stock-lots';

type Lot = {
  id: string;
  tenantId: string;
  branchId: string;
  locationId: string;
  productId: string;
  variantId: string | null;
  expiresOn: Date;
  lotCode: string | null;
  qty: number;
  receivedQty: number;
  createdAt: Date;
};

/**
 * Lo mínimo de `retailStockLot` que usa el helper, sobre un arreglo. Suficiente
 * para probar el orden FEFO y las cuentas; la consulta real la prueba Prisma.
 */
function fakeTx(lots: Lot[]) {
  let seq = lots.length;
  const matches = (lot: Lot, where: Record<string, unknown>) =>
    Object.entries(where).every(([field, value]) => {
      if (field === 'qty' && value && typeof value === 'object') {
        return lot.qty > (value as { gt: number }).gt;
      }
      const current = lot[field as keyof Lot];
      if (current instanceof Date && value instanceof Date) {
        return current.getTime() === value.getTime();
      }
      return current === value;
    });
  const byExpiry = (a: Lot, b: Lot) =>
    a.expiresOn.getTime() - b.expiresOn.getTime() ||
    a.createdAt.getTime() - b.createdAt.getTime();

  return {
    retailStockLot: {
      findMany: ({
        where,
        orderBy,
      }: {
        where: Record<string, unknown>;
        orderBy: Array<Record<string, string>>;
      }) => {
        const rows = lots.filter((lot) => matches(lot, where)).sort(byExpiry);
        return Promise.resolve(
          orderBy[0].expiresOn === 'desc' ? rows.reverse() : rows,
        );
      },
      findFirst: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(lots.find((lot) => matches(lot, where)) ?? null),
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, { increment?: number; decrement?: number }>;
      }) => {
        const lot = lots.find((row) => row.id === where.id)!;
        for (const field of ['qty', 'receivedQty'] as const) {
          const change = data[field];
          if (!change) continue;
          lot[field] += (change.increment ?? 0) - (change.decrement ?? 0);
        }
        return Promise.resolve(lot);
      },
      create: ({ data }: { data: Omit<Lot, 'id' | 'createdAt'> }) => {
        const lot = { ...data, id: `lot${++seq}`, createdAt: new Date(seq) };
        lots.push(lot);
        return Promise.resolve(lot);
      },
    },
  } as unknown as Prisma.TransactionClient;
}

const scope = { tenantId: 't', branchId: 'b' };
const main = { locationId: 'main', productId: 'p', variantId: 'arruru' };
const nia = { locationId: 'nia', productId: 'p', variantId: 'arruru' };

function lot(id: string, day: string, qty: number, received = qty): Lot {
  return {
    id,
    ...scope,
    ...main,
    expiresOn: lotDate(day),
    lotCode: null,
    qty,
    receivedQty: received,
    createdAt: new Date(Number(id.replace(/\D/g, ''))),
  };
}

describe('lotes de vencimiento', () => {
  it('la fecha ida y vuelta no se corre de día', () => {
    expect(lotDay(lotDate('2026-12-12'))).toBe('2026-12-12');
  });

  it('una salida consume primero lo que vence antes (FEFO)', async () => {
    const lots = [lot('l2', '2027-02-03', 5), lot('l1', '2026-12-12', 2)];
    const takes = await consumeLots(fakeTx(lots), scope, main, 4);

    expect(
      takes.map((take) => [lotDay(take.expiresOn), take.quantity]),
    ).toEqual([
      ['2026-12-12', 2],
      ['2027-02-03', 2],
    ]);
    expect(lots.find((row) => row.id === 'l1')!.qty).toBe(0);
    expect(lots.find((row) => row.id === 'l2')!.qty).toBe(3);
  });

  it('lo que no alcanzan a cubrir los lotes sale "sin fecha" sin error', async () => {
    const lots = [lot('l1', '2026-12-12', 1)];
    const takes = await consumeLots(fakeTx(lots), scope, main, 5);
    expect(takes).toHaveLength(1);
    expect(takes[0].quantity).toBe(1);
  });

  it('un traslado lleva las mismas fechas al destino', async () => {
    const lots = [lot('l1', '2026-12-12', 2), lot('l2', '2027-02-03', 5)];
    const tx = fakeTx(lots);
    const takes = await consumeLots(tx, scope, main, 3);
    await receiveLots(tx, scope, nia, 3, { kind: 'carry', takes });

    const atNia = lots.filter((row) => row.locationId === 'nia');
    expect(atNia.map((row) => [lotDay(row.expiresOn), row.qty])).toEqual([
      ['2026-12-12', 2],
      ['2027-02-03', 1],
    ]);
  });

  it('anular devuelve la unidad al lote del que salió', async () => {
    // Se vendieron 4: 2 del de diciembre (agotado) y 2 del de febrero.
    const lots = [lot('l1', '2026-12-12', 0, 2), lot('l2', '2027-02-03', 3, 5)];
    const tx = fakeTx(lots);
    // Se anula una venta de 3 unidades.
    await receiveLots(tx, scope, main, 3, { kind: 'restore' });

    // Inverso del FEFO: primero se rellena febrero (lo último que salió).
    expect(lots.find((row) => row.id === 'l2')!.qty).toBe(5);
    expect(lots.find((row) => row.id === 'l1')!.qty).toBe(1);
  });

  it('una entrada con fecha se suma al lote de ese día', async () => {
    const lots = [lot('l1', '2026-12-12', 2)];
    await receiveLots(fakeTx(lots), scope, main, 4, {
      kind: 'dated',
      expiresOn: '2026-12-12',
    });
    expect(lots).toHaveLength(1);
    expect(lots[0].qty).toBe(6);
    expect(lots[0].receivedQty).toBe(6);
  });

  it('respeta el lote que eligió el vendedor y el resto sale por FEFO', async () => {
    const lots = [lot('l1', '2026-12-12', 3), lot('l2', '2027-02-03', 6)];
    const takes = await consumeLots(fakeTx(lots), scope, main, 2, [
      { lotId: 'l2', qty: 1 },
    ]);
    expect(takes.map((take) => [take.lotId, take.quantity])).toEqual([
      ['l2', 1],
      ['l1', 1],
    ]);
  });

  it('elegir "sin fecha" no toca ningún lote', async () => {
    const lots = [lot('l1', '2026-12-12', 3)];
    const takes = await consumeLots(fakeTx(lots), scope, main, 1, [
      { lotId: null, qty: 1 },
    ]);
    expect(takes).toHaveLength(0);
    expect(lots[0].qty).toBe(3);
  });

  it('el registro incluye lo "sin fecha" y la fecha anotada', () => {
    const allocations = buildAllocations(
      [
        {
          lotId: 'l1',
          expiresOn: lotDate('2026-12-12'),
          lotCode: null,
          quantity: 1,
        },
      ],
      3,
      [{ qty: 1, expiresOn: '2027-01-01' }],
    );
    expect(allocations).toEqual([
      { lotId: 'l1', expiresOn: '2026-12-12', qty: 1 },
      { lotId: null, expiresOn: '2027-01-01', qty: 1, noted: true },
      { lotId: null, expiresOn: null, qty: 1 },
    ]);
  });

  it('reparte el registro entre dos líneas del mismo sabor', () => {
    const [first, second] = splitAllocations(
      [
        { lotId: 'l1', expiresOn: '2026-12-12', qty: 2 },
        { lotId: 'l2', expiresOn: '2027-02-03', qty: 1 },
      ],
      [1, 2],
    );
    expect(first).toEqual([{ lotId: 'l1', expiresOn: '2026-12-12', qty: 1 }]);
    expect(second.map((row) => [row.lotId, row.qty])).toEqual([
      ['l1', 1],
      ['l2', 1],
    ]);
  });

  it('anular con registro devuelve al lote exacto', async () => {
    // Se vendió 1 del de febrero aunque había de diciembre.
    const lots = [lot('l1', '2026-12-12', 3, 3), lot('l2', '2027-02-03', 5, 6)];
    await receiveLots(fakeTx(lots), scope, main, 1, {
      kind: 'exact',
      allocations: [{ lotId: 'l2', qty: 1 }],
    });
    expect(lots.find((row) => row.id === 'l2')!.qty).toBe(6);
    expect(lots.find((row) => row.id === 'l1')!.qty).toBe(3);
  });
});
