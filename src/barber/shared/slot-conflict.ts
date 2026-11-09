import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { clockTimeCO } from '../../common/date.util';

type Db = Prisma.TransactionClient;

/**
 * Estados que NO ocupan el espacio. `status` es un string libre con variantes
 * de mayúsculas (ver appointment-status.ts), así que van todas.
 */
const FREE_STATUSES = [
  'CANCELLED',
  'cancelled',
  'Cancelled',
  'REJECTED',
  'rejected',
  'Rejected',
  'NO_SHOW',
  'no_show',
];

const PENDING_STATUSES = ['PENDING', 'pending', 'Pending'];

export type SlotClash = {
  id: string;
  status: string;
  scheduledAt: Date;
  scheduledEnd: Date;
  customerName: string | null;
  serviceName: string;
  staffName: string | null;
};

/**
 * Qué ocupa el espacio pedido. Misma regla que la reserva pública
 * (barber-public.service): con especialista, el choque es por persona; sin
 * especialista (canchas, salones), por el propio servicio/espacio.
 *
 * Separa lo confirmado de lo pendiente de aprobar: una reserva PENDING del
 * sitio todavía no es un hecho, pero tampoco se puede ignorar en silencio.
 */
export async function findSlotClashes(
  db: Db,
  input: {
    branchId: string;
    staffId?: string | null;
    serviceId: string;
    start: Date;
    end: Date;
    excludeId?: string;
  },
): Promise<{ confirmed: SlotClash[]; pending: SlotClash[] }> {
  const rows = await db.barberAppointment.findMany({
    where: {
      branchId: input.branchId,
      ...(input.staffId
        ? { staffId: input.staffId }
        : { serviceId: input.serviceId }),
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      status: { notIn: FREE_STATUSES },
      scheduledAt: { lt: input.end },
      scheduledEnd: { gt: input.start },
    },
    select: {
      id: true,
      status: true,
      scheduledAt: true,
      scheduledEnd: true,
      customer: { select: { name: true } },
      service: { select: { name: true } },
      staff: { select: { name: true } },
    },
    orderBy: { scheduledAt: 'asc' },
  });
  const clashes = rows.map((r) => ({
    id: r.id,
    status: r.status,
    scheduledAt: r.scheduledAt,
    scheduledEnd: r.scheduledEnd,
    customerName: r.customer?.name ?? null,
    serviceName: r.service.name,
    staffName: r.staff?.name ?? null,
  }));
  return {
    confirmed: clashes.filter((c) => !PENDING_STATUSES.includes(c.status)),
    pending: clashes.filter((c) => PENDING_STATUSES.includes(c.status)),
  };
}

const describe = (c: SlotClash) =>
  `${c.serviceName}${c.staffName ? ` con ${c.staffName}` : ''} · ${c.customerName ?? 'sin cliente registrado'} (${clockTimeCO(c.scheduledAt).slice(0, 5)}–${clockTimeCO(c.scheduledEnd).slice(0, 5)})`;

/**
 * Lanza 409 si el espacio está ocupado:
 * - SLOT_TAKEN: ya hay una cita confirmada/agendada. No se puede cruzar.
 * - SLOT_PENDING: solo hay reservas pendientes de aprobar. Se permite si quien
 *   agenda lo confirma (`allowOverPending`); esas pendientes ya no se podrán
 *   aprobar, porque solo una puede ocupar el espacio.
 */
export function assertSlotFree(
  clashes: { confirmed: SlotClash[]; pending: SlotClash[] },
  options: { allowOverPending?: boolean } = {},
) {
  if (clashes.confirmed.length > 0) {
    throw new ConflictException({
      code: 'SLOT_TAKEN',
      message: `Ese horario ya está ocupado: ${clashes.confirmed.map(describe).join('; ')}.`,
      clashes: clashes.confirmed,
    });
  }
  if (clashes.pending.length > 0 && !options.allowOverPending) {
    throw new ConflictException({
      code: 'SLOT_PENDING',
      message: `Hay ${clashes.pending.length === 1 ? 'una reserva pendiente' : `${clashes.pending.length} reservas pendientes`} de aprobar en ese horario: ${clashes.pending.map(describe).join('; ')}. Si agendas aquí, esa reserva ya no se podrá aprobar.`,
      clashes: clashes.pending,
    });
  }
}
