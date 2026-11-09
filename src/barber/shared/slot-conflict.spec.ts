import { ConflictException } from '@nestjs/common';
import {
  assertSlotFree,
  findSlotClashes,
  type SlotClash,
} from './slot-conflict';

const clash = (status: string): SlotClash => ({
  id: status,
  status,
  scheduledAt: new Date('2026-11-10T15:00:00Z'),
  scheduledEnd: new Date('2026-11-10T16:00:00Z'),
  customerName: 'Ana',
  serviceName: 'Corte',
  staffName: 'Luis',
});

const codeOf = (fn: () => void) => {
  try {
    fn();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(ConflictException);
    return ((err as ConflictException).getResponse() as { code: string }).code;
  }
};

describe('assertSlotFree', () => {
  it('espacio libre: no lanza', () => {
    expect(
      codeOf(() => assertSlotFree({ confirmed: [], pending: [] })),
    ).toBeNull();
  });

  it('cita confirmada en el espacio: SLOT_TAKEN aunque se acepten pendientes', () => {
    expect(
      codeOf(() =>
        assertSlotFree(
          { confirmed: [clash('CONFIRMED')], pending: [] },
          { allowOverPending: true },
        ),
      ),
    ).toBe('SLOT_TAKEN');
  });

  it('solo pendiente de aprobar: SLOT_PENDING, y pasa si quien agenda lo confirma', () => {
    const clashes = { confirmed: [], pending: [clash('PENDING')] };
    expect(codeOf(() => assertSlotFree(clashes))).toBe('SLOT_PENDING');
    expect(
      codeOf(() => assertSlotFree(clashes, { allowOverPending: true })),
    ).toBeNull();
  });
});

describe('findSlotClashes', () => {
  it('con especialista busca por persona; sin especialista, por el servicio/espacio', async () => {
    const calls: unknown[] = [];
    const db = {
      barberAppointment: {
        findMany: (args: { where: unknown }) => {
          calls.push(args.where);
          return Promise.resolve([]);
        },
      },
    } as never;
    const base = {
      branchId: 'b',
      serviceId: 's',
      start: new Date(),
      end: new Date(),
    };
    await findSlotClashes(db, { ...base, staffId: 'st' });
    await findSlotClashes(db, { ...base, staffId: null, excludeId: 'x' });
    expect(calls[0]).toMatchObject({ staffId: 'st' });
    expect(calls[0]).not.toHaveProperty('serviceId');
    expect(calls[1]).toMatchObject({ serviceId: 's', id: { not: 'x' } });
  });

  it('separa pendientes de confirmadas', async () => {
    const row = (status: string) => ({
      id: status,
      status,
      scheduledAt: new Date(),
      scheduledEnd: new Date(),
      customer: null,
      service: { name: 'Cancha' },
      staff: null,
    });
    const db = {
      barberAppointment: {
        findMany: () =>
          Promise.resolve([row('PENDING'), row('CONFIRMED'), row('SCHEDULED')]),
      },
    } as never;
    const r = await findSlotClashes(db, {
      branchId: 'b',
      serviceId: 's',
      start: new Date(),
      end: new Date(),
    });
    expect(r.pending.map((c) => c.id)).toEqual(['PENDING']);
    expect(r.confirmed.map((c) => c.id)).toEqual(['CONFIRMED', 'SCHEDULED']);
    expect(r.confirmed[0].customerName).toBeNull();
  });
});
