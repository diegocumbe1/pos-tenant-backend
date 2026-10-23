import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  CO_UTC_OFFSET,
  addCalendarDaysCO,
  calendarDayCO,
} from '../../../common/date.util';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import {
  OccurrenceConflict,
  ensureRecurringHorizon,
  generateOccurrences,
  horizonEnd,
} from '../../shared/recurring-horizon';
import {
  CreateBarberRecurringBookingDto,
  EndBarberRecurringBookingDto,
} from './dto/barber-recurring.dto';

const FREED = ['CANCELLED', 'cancelled', 'REJECTED', 'rejected'];
const DONE = ['COMPLETED', 'completed', 'Completed'];

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function dayOf(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/**
 * Reservas fijas semanales (canchas): "Equipo X · cancha 2 · martes 20:00".
 * En canchas se paga el día, así que no hay mensualidad: cada semana es una
 * reserva normal con el precio pactado, que se cobra cuando juegan.
 */
@Injectable()
export class BarberRecurringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
  ) {}

  async list(ctx: TenantContext) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    await ensureRecurringHorizon(this.prisma, ctx.branchId);
    const today = calendarDayCO(new Date());
    const rows = await this.prisma.barberRecurringBooking.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        service: { select: { id: true, name: true, color: true } },
        staff: { select: { id: true, name: true } },
        appointments: {
          where: {
            scheduledAt: { gte: new Date(`${today}T00:00:00${CO_UTC_OFFSET}`) },
          },
          select: { scheduledAt: true, status: true },
          orderBy: { scheduledAt: 'asc' },
        },
      },
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
    });
    return rows.map((r) => {
      const until = dayOf(r.activeUntil);
      const upcoming = r.appointments.filter((a) => !FREED.includes(a.status));
      return {
        id: r.id,
        customerId: r.customerId,
        customerName: r.customer.name,
        customerPhone: r.customer.phone,
        serviceId: r.serviceId,
        serviceName: r.service.name,
        color: r.service.color,
        staffId: r.staffId,
        staffName: r.staff?.name ?? null,
        weekday: r.weekday,
        startTime: r.startTime,
        durationMin: r.durationMin,
        priceCOP: r.priceCOP,
        activeFrom: dayOf(r.activeFrom),
        activeUntil: until,
        notes: r.notes,
        status: until && until < today ? 'ENDED' : 'ACTIVE',
        nextDate: upcoming[0] ? calendarDayCO(upcoming[0].scheduledAt) : null,
        upcomingCount: upcoming.length,
      };
    });
  }

  /**
   * Crea la reserva fija (una por día de la semana) y sus reservas de las
   * próximas semanas. Las fechas en que la cancha ya está ocupada NO se pisan:
   * se devuelven en `conflicts` para que el negocio decida.
   */
  async create(ctx: TenantContext, dto: CreateBarberRecurringBookingDto) {
    await this.tenantHelper.assertScopedRecord(
      'barberCustomer',
      ctx,
      dto.customerId,
      'Customer',
    );
    await this.tenantHelper.assertScopedRecord(
      'barberService',
      ctx,
      dto.serviceId,
      'Service',
    );
    if (dto.staffId) {
      await this.tenantHelper.assertScopedRecord(
        'barberStaff',
        ctx,
        dto.staffId,
        'Staff',
      );
    }
    const today = calendarDayCO(new Date());
    const activeFrom = dto.activeFrom ?? today;
    if (activeFrom < today) {
      throw new BadRequestException('La reserva fija empieza hoy o después');
    }
    if (dto.activeUntil && dto.activeUntil < activeFrom) {
      throw new BadRequestException(
        'La fecha de fin no puede ser antes del inicio',
      );
    }
    const service = await this.prisma.barberService.findUniqueOrThrow({
      where: { id: dto.serviceId },
      select: { priceCOP: true, durationMin: true, kind: true },
    });
    if (service.kind !== 'SERVICE') {
      throw new BadRequestException(
        'Las reservas fijas son para canchas o recursos, no para clases ni planes',
      );
    }
    // Sin precio pactado: el de la cancha, proporcional a la duración.
    const priceCOP =
      dto.priceCOP ??
      Math.round(
        (service.priceCOP * dto.durationMin) / Math.max(service.durationMin, 1),
      );

    const conflicts: OccurrenceConflict[] = [];
    const created: string[] = [];
    for (const weekday of [...new Set(dto.weekdays)]) {
      await this.prisma.$transaction(async (tx) => {
        const booking = await tx.barberRecurringBooking.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            customerId: dto.customerId,
            serviceId: dto.serviceId,
            staffId: dto.staffId ?? null,
            weekday,
            startTime: dto.startTime,
            durationMin: dto.durationMin,
            priceCOP,
            activeFrom: dateOf(activeFrom),
            activeUntil: dto.activeUntil ? dateOf(dto.activeUntil) : null,
            notes: dto.notes ?? null,
            userId: ctx.userId,
            userName: ctx.name,
          },
        });
        const end = horizonEnd(booking);
        const result = await generateOccurrences(tx, booking, activeFrom, end);
        await tx.barberRecurringBooking.update({
          where: { id: booking.id },
          data: { generatedUntil: dateOf(end) },
        });
        conflicts.push(...result.conflicts);
        created.push(...result.created);
      });
    }
    return {
      createdCount: created.length,
      conflicts: conflicts.sort((a, b) => a.day.localeCompare(b.day)),
    };
  }

  /**
   * Termina la reserva fija desde una fecha: desde ese día no hay más. Las
   * reservas futuras que todavía no se jugaron se cancelan; las pasadas y las
   * ya completadas (con sus cobros) quedan como están.
   */
  async end(ctx: TenantContext, id: string, dto: EndBarberRecurringBookingDto) {
    const booking = await this.prisma.barberRecurringBooking.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
    if (!booking)
      throw new NotFoundException(`Recurring booking ${id} not found`);
    const today = calendarDayCO(new Date());
    if (dto.from < today) {
      throw new BadRequestException(
        'Se termina desde hoy en adelante: el pasado no se reescribe',
      );
    }
    const from =
      dto.from < dayOf(booking.activeFrom)!
        ? dayOf(booking.activeFrom)!
        : dto.from;
    const lastDay = addCalendarDaysCO(from, -1);

    const cancelled = await this.prisma.$transaction(async (tx) => {
      await tx.barberRecurringBooking.update({
        where: { id },
        data: {
          activeUntil: dateOf(
            lastDay < dayOf(booking.activeFrom)!
              ? dayOf(booking.activeFrom)!
              : lastDay,
          ),
        },
      });
      const result = await tx.barberAppointment.updateMany({
        where: {
          recurringBookingId: id,
          scheduledAt: { gte: new Date(`${from}T00:00:00${CO_UTC_OFFSET}`) },
          status: { notIn: [...FREED, ...DONE] },
        },
        data: {
          status: 'CANCELLED',
          cancelReason: dto.reason ?? 'Reserva fija terminada',
        },
      });
      return result.count;
    });
    return { cancelledCount: cancelled };
  }
}
