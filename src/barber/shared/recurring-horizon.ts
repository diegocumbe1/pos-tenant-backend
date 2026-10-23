import { BarberRecurringBooking, Prisma, PrismaClient } from '@prisma/client';
import {
  CO_UTC_OFFSET,
  addCalendarDaysCO,
  calendarDayCO,
} from '../../common/date.util';

/**
 * Reservas fijas semanales: crear sus ocurrencias.
 *
 * Cada ocurrencia es una reserva NORMAL (BarberAppointment). Así bloquea la
 * cancha en la agenda y en la web con la misma regla de choques de siempre, se
 * cobra el día con su propio cobro y se cancela o se mueve sola.
 *
 * SIN PROCESO PROGRAMADO. Se crean hasta HORIZON_WEEKS adelante y, cada vez que
 * alguien abre la agenda o la reserva pública, `ensureRecurringHorizon` completa
 * lo que falte. El negocio que no abre Lynko en tres meses no pierde nada: lo
 * que se crea siempre empieza hoy, nunca en el pasado.
 */

export const HORIZON_WEEKS = 12;

/** Estados que liberan el espacio: lo cancelado no choca con nada. */
const FREED = ['CANCELLED', 'cancelled', 'REJECTED', 'rejected'];

type Db = PrismaClient | Prisma.TransactionClient;

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function dayOf(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

function weekdayOf(day: string): number {
  return dateOf(day).getUTCDay();
}

export type OccurrenceConflict = {
  day: string;
  startTime: string;
  /** Con quién choca, para decidir: "Juan Pérez" o "otra reserva". */
  withName: string;
};

/**
 * Crea las ocurrencias de una reserva fija entre dos días (incluidos). Las que
 * chocan con otra reserva de la misma cancha (o del mismo responsable) NO se
 * crean: se devuelven para que el negocio decida. Nunca pisa una reserva.
 */
export async function generateOccurrences(
  db: Db,
  booking: BarberRecurringBooking,
  fromDay: string,
  toDay: string,
): Promise<{ created: string[]; conflicts: OccurrenceConflict[] }> {
  const created: string[] = [];
  const conflicts: OccurrenceConflict[] = [];
  if (toDay < fromDay) return { created, conflicts };

  // Primer día de la semana que toca dentro del rango.
  let day = fromDay;
  while (weekdayOf(day) !== booking.weekday) day = addCalendarDaysCO(day, 1);

  for (; day <= toDay; day = addCalendarDaysCO(day, 7)) {
    const scheduledAt = new Date(
      `${day}T${booking.startTime}:00${CO_UTC_OFFSET}`,
    );
    const scheduledEnd = new Date(
      scheduledAt.getTime() + booking.durationMin * 60_000,
    );

    const already = await db.barberAppointment.findFirst({
      where: { recurringBookingId: booking.id, scheduledAt },
      select: { id: true },
    });
    if (already) continue;

    const clash = await db.barberAppointment.findFirst({
      where: {
        branchId: booking.branchId,
        status: { notIn: FREED },
        scheduledAt: { lt: scheduledEnd },
        scheduledEnd: { gt: scheduledAt },
        OR: [
          { serviceId: booking.serviceId },
          ...(booking.staffId ? [{ staffId: booking.staffId }] : []),
        ],
      },
      select: { customer: { select: { name: true } } },
    });
    if (clash) {
      conflicts.push({
        day,
        startTime: booking.startTime,
        withName: clash.customer?.name ?? 'otra reserva',
      });
      continue;
    }

    await db.barberAppointment.create({
      data: {
        tenantId: booking.tenantId,
        branchId: booking.branchId,
        customerId: booking.customerId,
        serviceId: booking.serviceId,
        staffId: booking.staffId,
        scheduledAt,
        scheduledEnd,
        status: 'CONFIRMED',
        source: 'recurring',
        // El precio pactado (precio de equipo) va desde ya: al completarla se
        // conserva en vez de tomar el de lista de la cancha.
        priceCOP: booking.priceCOP,
        notes: booking.notes,
        recurringBookingId: booking.id,
      },
    });
    created.push(day);
  }
  return { created, conflicts };
}

/** Último día que debe quedar creado: hoy + horizonte, sin pasar del fin. */
export function horizonEnd(booking: { activeUntil: Date | null }): string {
  const horizon = addCalendarDaysCO(
    calendarDayCO(new Date()),
    HORIZON_WEEKS * 7,
  );
  const until = dayOf(booking.activeUntil);
  return until && until < horizon ? until : horizon;
}

/**
 * Completa hacia adelante las reservas fijas de una sede. Barato cuando no hay
 * nada que hacer (una consulta indexada), así que se llama al abrir la agenda y
 * la reserva pública.
 *
 * DOS PESTAÑAS A LA VEZ no duplican: cada reserva fija se "reclama" moviendo su
 * `generatedUntil` con una condición sobre el valor anterior; la que llega
 * segunda encuentra el valor cambiado y no hace nada.
 */
export async function ensureRecurringHorizon(
  prisma: PrismaClient,
  branchId: string,
): Promise<void> {
  const today = calendarDayCO(new Date());
  const horizon = addCalendarDaysCO(today, HORIZON_WEEKS * 7);
  const pending = await prisma.barberRecurringBooking.findMany({
    where: {
      branchId,
      OR: [{ activeUntil: null }, { activeUntil: { gte: dateOf(today) } }],
      AND: [
        {
          OR: [
            { generatedUntil: null },
            { generatedUntil: { lt: dateOf(horizon) } },
          ],
        },
      ],
    },
  });

  for (const booking of pending) {
    const end = horizonEnd(booking);
    const lastDone = dayOf(booking.generatedUntil);
    if (lastDone && lastDone >= end) continue;
    const activeFrom = dayOf(booking.activeFrom)!;
    const candidates = [
      today,
      activeFrom,
      ...(lastDone ? [addCalendarDaysCO(lastDone, 1)] : []),
    ];
    const from = candidates.sort().at(-1)!;

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.barberRecurringBooking.updateMany({
        where: { id: booking.id, generatedUntil: booking.generatedUntil },
        data: { generatedUntil: dateOf(end) },
      });
      if (claimed.count === 0) return; // otra pestaña ya lo hizo
      await generateOccurrences(tx, booking, from, end);
    });
  }
}
