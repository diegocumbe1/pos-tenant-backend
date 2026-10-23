import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  CO_UTC_OFFSET,
  addCalendarDaysCO,
  calendarDayCO,
  diffCalendarDaysCO,
} from '../../../common/date.util';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import { BarberAppointmentsService } from '../appointments/barber-appointments.service';
import { BarberChargesService } from '../charges/barber-charges.service';
import {
  AddBarberClassAttendeeDto,
  BarberClassSessionRefDto,
  CreateBarberClassEnrollmentDto,
  CreateBarberClassScheduleDto,
  MarkBarberClassAttendanceDto,
  UpdateBarberClassScheduleDto,
  UpdateBarberClassSessionDto,
} from './dto/barber-class.dto';

/** Estados de cita que NO ocupan cupo: la persona ya no va. */
const FREED_STATUSES = ['CANCELLED', 'cancelled', 'REJECTED', 'rejected'];
const MAX_RANGE_DAYS = 62;
const WEEKDAY_NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

function dayOf(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Día de la semana de una fecha calendario: 0 = domingo. */
function weekdayOf(day: string): number {
  return dateOf(day).getUTCDay();
}

/** El instante de inicio de una clase: ese día, a esa hora, en Colombia. */
function instantOf(day: string, time: string): Date {
  return new Date(`${day}T${time}:00${CO_UTC_OFFSET}`);
}

type ScheduleRow = Prisma.BarberClassScheduleGetPayload<{
  include: {
    service: { select: { id: true; name: true; color: true; priceCOP: true } };
    staff: { select: { id: true; name: true } };
  };
}>;

type ResolvedSession = {
  sessionId: string | null;
  scheduleId: string | null;
  serviceId: string;
  staffId: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  status: string;
};

/**
 * Clases grupales.
 *
 * LA CLASE SE GUARDA CUANDO ENTRA EL PRIMERO. Las clases futuras se calculan
 * desde el horario fijo y no existen en la base hasta que alguien se inscribe:
 * así no hace falta un proceso que corra cada noche creando clases (no hay
 * scheduler), y cambiar un horario no deja clases vacías huérfanas.
 *
 * CADA ASISTENTE ES UNA CITA. Con eso el historial del cliente, sus visitas,
 * la lista "por atender" y la comisión del entrenador siguen funcionando sin
 * saber que existen las clases.
 *
 * LA INSCRIPCIÓN FIJA OCUPA CUPO. Quien va siempre los lunes aparece como
 * "esperado" en cada clase del lunes y su puesto no se le da a otro, aunque
 * todavía no tenga cita.
 */
@Injectable()
export class BarberClassesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
    private readonly appointments: BarberAppointmentsService,
    private readonly charges: BarberChargesService,
  ) {}

  // ─── Horarios ──────────────────────────────────────────────────────────────

  /**
   * Los horarios con su estado: vigente, por empezar, terminado (una versión
   * que se reemplazó desde una fecha) o archivado. Por defecto solo los que
   * siguen sirviendo; con `includeHistory` también los demás.
   */
  async listSchedules(ctx: TenantContext, includeHistory = false) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    const today = calendarDayCO(new Date());
    const rows = await this.prisma.barberClassSchedule.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        ...(includeHistory
          ? {}
          : {
              isActive: true,
              OR: [
                { activeUntil: null },
                { activeUntil: { gte: dateOf(today) } },
              ],
            }),
      },
      include: {
        service: {
          select: { id: true, name: true, color: true, priceCOP: true },
        },
        staff: { select: { id: true, name: true } },
        enrollments: {
          where: {
            OR: [
              { activeUntil: null },
              { activeUntil: { gte: dateOf(today) } },
            ],
          },
          include: {
            customer: { select: { id: true, name: true, phone: true } },
          },
        },
        _count: { select: { sessions: true } },
      },
      orderBy: [
        { weekday: 'asc' },
        { startTime: 'asc' },
        { activeFrom: 'asc' },
      ],
    });
    return rows.map((row) => {
      const activeFrom = dayOf(row.activeFrom)!;
      const activeUntil = dayOf(row.activeUntil);
      const status = !row.isActive
        ? 'ARCHIVED'
        : activeUntil && activeUntil < today
          ? 'ENDED'
          : activeFrom > today
            ? 'UPCOMING'
            : 'ACTIVE';
      return {
        id: row.id,
        serviceId: row.serviceId,
        serviceName: row.service.name,
        color: row.service.color,
        staffId: row.staffId,
        staffName: row.staff?.name ?? null,
        weekday: row.weekday,
        startTime: row.startTime,
        durationMin: row.durationMin,
        capacity: row.capacity,
        activeFrom,
        activeUntil,
        status,
        /** Ya tuvo clases con gente: no se puede borrar, solo archivar. */
        hasHistory: row._count.sessions > 0,
        enrollments: row.enrollments.map((e) => ({
          id: e.id,
          customerId: e.customerId,
          customerName: e.customer.name,
          customerPhone: e.customer.phone,
          activeFrom: dayOf(e.activeFrom),
        })),
      };
    });
  }

  async createSchedules(ctx: TenantContext, dto: CreateBarberClassScheduleDto) {
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
    const service = await this.prisma.barberService.findUniqueOrThrow({
      where: { id: dto.serviceId },
      select: { durationMin: true, capacity: true, name: true },
    });
    const activeFrom = dto.activeFrom ?? calendarDayCO(new Date());
    if (dto.activeUntil && dto.activeUntil < activeFrom) {
      throw new BadRequestException(
        'La fecha de fin no puede ser antes de la de inicio',
      );
    }

    const weekdays = [...new Set(dto.weekdays)];

    // Dos horarios iguales (misma clase, mismo día, misma hora, vigentes al
    // tiempo) parten el cupo en dos y nadie sabe en cuál inscribir.
    const clashes = await this.prisma.barberClassSchedule.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        serviceId: dto.serviceId,
        startTime: dto.startTime,
        weekday: { in: weekdays },
        isActive: true,
        OR: [
          { activeUntil: null },
          { activeUntil: { gte: dateOf(activeFrom) } },
        ],
        ...(dto.activeUntil
          ? { activeFrom: { lte: dateOf(dto.activeUntil) } }
          : {}),
      },
      select: { weekday: true },
    });
    if (clashes.length > 0) {
      const days = [...new Set(clashes.map((c) => WEEKDAY_NAMES[c.weekday]))];
      throw new ConflictException({
        code: 'SCHEDULE_EXISTS',
        message: `Ya existe ${service.name} a las ${dto.startTime} el ${days.join(', ')}. Edita ese horario en vez de crear otro.`,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      for (const weekday of weekdays) {
        const row = await tx.barberClassSchedule.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            serviceId: dto.serviceId,
            staffId: dto.staffId ?? null,
            weekday,
            startTime: dto.startTime,
            durationMin: dto.durationMin ?? service.durationMin,
            // Una clase con cupo 1 no es una clase: si el servicio no trae cupo,
            // se exige escribirlo.
            capacity: dto.capacity ?? Math.max(service.capacity, 1),
            activeFrom: dateOf(activeFrom),
            activeUntil: dto.activeUntil ? dateOf(dto.activeUntil) : null,
          },
        });
        await this.logEvent(tx, ctx, row.id, {
          kind: 'CREATED',
          summary: `Horario creado: ${service.name} · ${WEEKDAY_NAMES[weekday]} ${row.startTime} · ${row.durationMin} min · cupo ${row.capacity}, desde el ${activeFrom}`,
        });
      }
    });
    return this.listSchedules(ctx);
  }

  /**
   * Cambia hora, duración, cupo o entrenador de un horario DESDE UNA FECHA.
   *
   * SI EL HORARIO YA ESTÁ CORRIENDO, SE PARTE EN DOS VERSIONES. La vieja termina
   * el día anterior y la nueva arranca en `effectiveFrom`. Así el pasado sigue
   * diciendo lo que fue (la clase del lunes pasado SÍ fue a las 17:00) y el
   * historial muestra desde cuándo cambió. Si todavía no ha empezado, se edita
   * en el mismo registro: no hay pasado que proteger.
   *
   * LAS CLASES QUE YA TIENEN GENTE SE MUEVEN. Una clase futura guardada (alguien
   * ya se inscribió) pasa a la versión nueva con la hora nueva, y las citas de
   * sus inscritos con ella. La inscripción fija también pasa a la versión nueva.
   */
  async updateSchedule(
    ctx: TenantContext,
    id: string,
    dto: UpdateBarberClassScheduleDto,
  ) {
    const current = await this.findSchedule(ctx, id);
    if (!current.isActive) {
      throw new BadRequestException(
        'El horario está archivado: restáuralo primero',
      );
    }
    if (dto.staffId) {
      await this.tenantHelper.assertScopedRecord(
        'barberStaff',
        ctx,
        dto.staffId,
        'Staff',
      );
    }
    const today = calendarDayCO(new Date());
    const effectiveFrom = dto.effectiveFrom ?? today;
    if (effectiveFrom < today) {
      throw new BadRequestException(
        'Los cambios aplican desde hoy en adelante: el pasado no se reescribe',
      );
    }
    const currentUntil = dayOf(current.activeUntil);
    if (currentUntil && effectiveFrom > currentUntil) {
      throw new BadRequestException(
        'Ese horario ya termina antes de esa fecha',
      );
    }

    const next = {
      startTime: dto.startTime ?? current.startTime,
      durationMin: dto.durationMin ?? current.durationMin,
      capacity: dto.capacity ?? current.capacity,
      staffId: dto.staffId === undefined ? current.staffId : dto.staffId,
    };
    const changes = this.describeChanges(current, next);
    if (changes.length === 0) {
      throw new BadRequestException('No hay cambios');
    }

    const splits = effectiveFrom > dayOf(current.activeFrom)!;
    await this.prisma.$transaction(async (tx) => {
      let targetId = id;
      if (splits) {
        const created = await tx.barberClassSchedule.create({
          data: {
            tenantId: current.tenantId,
            branchId: current.branchId,
            serviceId: current.serviceId,
            weekday: current.weekday,
            activeFrom: dateOf(effectiveFrom),
            activeUntil: current.activeUntil,
            ...next,
          },
        });
        targetId = created.id;
        const dayBefore = addCalendarDaysCO(effectiveFrom, -1);
        await tx.barberClassSchedule.update({
          where: { id },
          data: { activeUntil: dateOf(dayBefore) },
        });

        // La inscripción fija pasa a la versión nueva; en la vieja termina el
        // día anterior. Nadie tiene que volver a inscribirse.
        const enrollments = await tx.barberClassEnrollment.findMany({
          where: {
            scheduleId: id,
            OR: [
              { activeUntil: null },
              { activeUntil: { gte: dateOf(effectiveFrom) } },
            ],
          },
        });
        for (const e of enrollments) {
          const from = dayOf(e.activeFrom)!;
          await tx.barberClassEnrollment.create({
            data: {
              tenantId: e.tenantId,
              branchId: e.branchId,
              scheduleId: created.id,
              customerId: e.customerId,
              activeFrom: dateOf(from > effectiveFrom ? from : effectiveFrom),
              activeUntil: e.activeUntil,
            },
          });
          if (from >= effectiveFrom) {
            // Nunca alcanzó a correr en la versión vieja: se cierra el mismo día
            // en que empezó, para que no quede vigente en las dos.
            await tx.barberClassEnrollment.update({
              where: { id: e.id },
              data: { activeUntil: e.activeFrom },
            });
          } else {
            await tx.barberClassEnrollment.update({
              where: { id: e.id },
              data: { activeUntil: dateOf(dayBefore) },
            });
          }
        }

        await this.logEvent(tx, ctx, id, {
          kind: 'SPLIT',
          summary: `Cambiado desde el ${effectiveFrom}: ${changes.join(' · ')}. Esta versión termina el ${dayBefore}.`,
          detail: { effectiveFrom, newScheduleId: created.id, changes },
        });
        await this.logEvent(tx, ctx, created.id, {
          kind: 'CREATED',
          summary: `Nueva versión desde el ${effectiveFrom}: ${changes.join(' · ')}`,
          detail: { effectiveFrom, previousScheduleId: id, changes },
        });
      } else {
        await tx.barberClassSchedule.update({ where: { id }, data: next });
        await this.logEvent(tx, ctx, id, {
          kind: 'UPDATED',
          summary: `Cambiado: ${changes.join(' · ')}`,
          detail: { changes },
        });
      }

      // Las clases ya guardadas desde esa fecha toman el horario nuevo.
      const sessions = await tx.barberClassSession.findMany({
        where: {
          scheduleId: id,
          startsAt: { gte: instantOf(effectiveFrom, '00:00') },
        },
        select: { id: true, startsAt: true },
      });
      for (const session of sessions) {
        const day = calendarDayCO(session.startsAt);
        const startsAt = instantOf(day, next.startTime);
        const endsAt = new Date(startsAt.getTime() + next.durationMin * 60_000);
        await tx.barberClassSession.update({
          where: { id: session.id },
          data: {
            scheduleId: targetId,
            startsAt,
            endsAt,
            capacity: next.capacity,
            staffId: next.staffId,
          },
        });
        await tx.barberAppointment.updateMany({
          where: { classSessionId: session.id },
          data: {
            scheduledAt: startsAt,
            scheduledEnd: endsAt,
            staffId: next.staffId,
          },
        });
      }
    });
    return this.listSchedules(ctx);
  }

  /** Archivar lo esconde sin perder nada: clases, asistencia e historial quedan. */
  async archiveSchedule(ctx: TenantContext, id: string) {
    const current = await this.findSchedule(ctx, id);
    if (!current.isActive) return this.listSchedules(ctx, true);
    await this.prisma.$transaction(async (tx) => {
      await tx.barberClassSchedule.update({
        where: { id },
        data: { isActive: false },
      });
      await this.logEvent(tx, ctx, id, {
        kind: 'ARCHIVED',
        summary: 'Horario archivado',
      });
    });
    return this.listSchedules(ctx, true);
  }

  async restoreSchedule(ctx: TenantContext, id: string) {
    const current = await this.findSchedule(ctx, id);
    if (current.isActive) return this.listSchedules(ctx, true);
    await this.prisma.$transaction(async (tx) => {
      await tx.barberClassSchedule.update({
        where: { id },
        data: { isActive: true },
      });
      await this.logEvent(tx, ctx, id, {
        kind: 'RESTORED',
        summary: 'Horario restaurado',
      });
    });
    return this.listSchedules(ctx, true);
  }

  /**
   * Borrar es para lo que se creó por error: un horario que nunca tuvo una
   * clase guardada. Si ya tuvo gente, hay asistencias y pagos colgando de él y
   * se archiva en vez de borrarse.
   */
  async deleteSchedule(ctx: TenantContext, id: string) {
    await this.findSchedule(ctx, id);
    const used = await this.prisma.barberClassSession.count({
      where: { scheduleId: id },
    });
    if (used > 0) {
      throw new ConflictException({
        code: 'SCHEDULE_HAS_HISTORY',
        message:
          'Este horario ya tuvo clases con gente. Archívalo en vez de borrarlo.',
      });
    }
    await this.prisma.barberClassSchedule.delete({ where: { id } });
    return { ok: true };
  }

  async listScheduleEvents(ctx: TenantContext, id: string) {
    await this.findSchedule(ctx, id);
    return this.prisma.barberClassScheduleEvent.findMany({
      where: { scheduleId: id },
      orderBy: { occurredAt: 'desc' },
      select: {
        id: true,
        kind: true,
        summary: true,
        userName: true,
        occurredAt: true,
      },
    });
  }

  /**
   * Solo esta clase: cupo, entrenador o cancelarla. No cambia el horario.
   * Cancelarla libera a los inscritos: su cita queda cancelada y, si un paquete
   * la cubría, la sesión le vuelve al paquete.
   */
  async updateSession(ctx: TenantContext, dto: UpdateBarberClassSessionDto) {
    const resolved = await this.resolveSession(ctx, dto);
    if (dto.staffId) {
      await this.tenantHelper.assertScopedRecord(
        'barberStaff',
        ctx,
        dto.staffId,
        'Staff',
      );
    }
    const day = calendarDayCO(resolved.startsAt);
    const touched = new Set<string>();
    const sessionId = await this.prisma.$transaction(async (tx) => {
      const id = await this.materialize(tx, ctx, resolved);
      const lines: string[] = [];
      if (dto.capacity !== undefined && dto.capacity !== resolved.capacity) {
        lines.push(`cupo ${resolved.capacity} → ${dto.capacity}`);
      }
      if (dto.staffId !== undefined && dto.staffId !== resolved.staffId) {
        lines.push('cambio de entrenador');
      }
      await tx.barberClassSession.update({
        where: { id },
        data: {
          capacity: dto.capacity,
          staffId: dto.staffId === undefined ? undefined : dto.staffId,
          status: dto.status,
        },
      });
      if (dto.staffId !== undefined) {
        await tx.barberAppointment.updateMany({
          where: { classSessionId: id },
          data: { staffId: dto.staffId },
        });
      }
      if (dto.status === 'CANCELLED' && resolved.status !== 'CANCELLED') {
        const attendees = await tx.barberAppointment.findMany({
          where: { classSessionId: id, status: { notIn: FREED_STATUSES } },
          select: { customerId: true },
        });
        attendees.forEach((a) => touched.add(a.customerId));
        await tx.barberAppointment.updateMany({
          where: { classSessionId: id, status: { notIn: FREED_STATUSES } },
          data: {
            status: 'CANCELLED',
            cancelReason: dto.reason ?? 'Clase cancelada',
            coveredByChargeId: null,
          },
        });
        if (resolved.scheduleId) {
          await this.logEvent(tx, ctx, resolved.scheduleId, {
            kind: 'SESSION_CANCELLED',
            summary: `Clase del ${day} cancelada${dto.reason ? `: ${dto.reason}` : ''} (${attendees.length} inscrito(s) liberado(s))`,
            detail: { sessionId: id, day },
          });
        }
      } else if (
        dto.status === 'SCHEDULED' &&
        resolved.status === 'CANCELLED'
      ) {
        if (resolved.scheduleId) {
          await this.logEvent(tx, ctx, resolved.scheduleId, {
            kind: 'SESSION_RESTORED',
            summary: `Clase del ${day} reactivada`,
            detail: { sessionId: id, day },
          });
        }
      }
      if (lines.length && resolved.scheduleId) {
        await this.logEvent(tx, ctx, resolved.scheduleId, {
          kind: 'SESSION_UPDATED',
          summary: `Solo la clase del ${day}: ${lines.join(' · ')}`,
          detail: { sessionId: id, day },
        });
      }
      return id;
    });
    for (const customerId of touched) await this.syncVisits(customerId);
    return this.roster(ctx, { sessionId });
  }

  // ─── Inscripción fija ──────────────────────────────────────────────────────

  async enroll(
    ctx: TenantContext,
    scheduleId: string,
    dto: CreateBarberClassEnrollmentDto,
  ) {
    await this.findSchedule(ctx, scheduleId);
    await this.tenantHelper.assertScopedRecord(
      'barberCustomer',
      ctx,
      dto.customerId,
      'Customer',
    );
    const today = calendarDayCO(new Date());
    const activeFrom = dto.activeFrom ?? today;

    await this.prisma.$transaction(async (tx) => {
      const active = await tx.barberClassEnrollment.findMany({
        where: {
          scheduleId,
          OR: [{ activeUntil: null }, { activeUntil: { gte: dateOf(today) } }],
        },
        select: { customerId: true },
      });
      if (active.some((e) => e.customerId === dto.customerId)) {
        throw new ConflictException({
          code: 'ALREADY_ENROLLED',
          message: 'Ya está inscrito en esta clase',
        });
      }
      // El cupo es una guía, no un tope: se deja inscribir y la pantalla avisa
      // que el horario queda por encima ("excede cupo +N").
      await tx.barberClassEnrollment.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          scheduleId,
          customerId: dto.customerId,
          activeFrom: dateOf(activeFrom),
        },
      });
    });
    return this.listSchedules(ctx);
  }

  /**
   * Retirar a alguien cierra su inscripción AYER: desde hoy deja de aparecer
   * como esperado y su puesto queda libre. El histórico se queda.
   */
  async unenroll(ctx: TenantContext, enrollmentId: string) {
    const row = await this.prisma.barberClassEnrollment.findFirst({
      where: {
        id: enrollmentId,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
      },
      select: { id: true },
    });
    if (!row)
      throw new NotFoundException(`Enrollment ${enrollmentId} not found`);
    const yesterday = addCalendarDaysCO(calendarDayCO(new Date()), -1);
    await this.prisma.barberClassEnrollment.update({
      where: { id: enrollmentId },
      data: { activeUntil: dateOf(yesterday) },
    });
    return this.listSchedules(ctx);
  }

  /**
   * Los horarios fijos de un cliente: los vigentes hoy o que empiezan después.
   * Es lo que muestra su ficha ("va lunes, miércoles y viernes a las 17:00").
   */
  async customerEnrollments(ctx: TenantContext, customerId: string) {
    await this.tenantHelper.assertScopedRecord(
      'barberCustomer',
      ctx,
      customerId,
      'Customer',
    );
    const today = calendarDayCO(new Date());
    const rows = await this.prisma.barberClassEnrollment.findMany({
      where: {
        customerId,
        OR: [{ activeUntil: null }, { activeUntil: { gte: dateOf(today) } }],
        schedule: { isActive: true },
      },
      include: {
        schedule: {
          include: {
            service: { select: { name: true, color: true } },
            staff: { select: { name: true } },
          },
        },
      },
    });
    return rows
      .map((e) => ({
        id: e.id,
        scheduleId: e.scheduleId,
        serviceName: e.schedule.service.name,
        color: e.schedule.service.color,
        staffName: e.schedule.staff?.name ?? null,
        weekday: e.schedule.weekday,
        startTime: e.schedule.startTime,
        activeFrom: dayOf(e.activeFrom),
        activeUntil: dayOf(e.activeUntil),
      }))
      .sort(
        (a, b) =>
          ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) ||
          a.startTime.localeCompare(b.startTime),
      );
  }

  // ─── Calendario de clases ──────────────────────────────────────────────────

  /**
   * Las clases de un rango: las guardadas (con gente) más las que salen de los
   * horarios y todavía no tienen a nadie. Cada una con su cupo ocupado.
   */
  async listSessions(ctx: TenantContext, from: string, to: string) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    if (to < from) throw new BadRequestException('Rango inválido');
    if (diffCalendarDaysCO(from, to) > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `El rango no puede pasar de ${MAX_RANGE_DAYS} días`,
      );
    }
    const scope = { tenantId: ctx.tenantId, branchId: ctx.branchId };
    const window = {
      gte: instantOf(from, '00:00'),
      lte: instantOf(to, '23:59'),
    };

    const [schedules, stored] = await Promise.all([
      this.prisma.barberClassSchedule.findMany({
        where: { ...scope, isActive: true },
        include: {
          service: {
            select: { id: true, name: true, color: true, priceCOP: true },
          },
          staff: { select: { id: true, name: true } },
          enrollments: true,
        },
      }),
      this.prisma.barberClassSession.findMany({
        where: { ...scope, startsAt: window },
        include: {
          service: { select: { id: true, name: true, color: true } },
          staff: { select: { id: true, name: true } },
          attendees: {
            where: { status: { notIn: FREED_STATUSES } },
            select: { customerId: true },
          },
        },
      }),
    ]);

    const storedKey = new Map(
      stored
        .filter((s) => s.scheduleId)
        .map((s) => [`${s.scheduleId}|${s.startsAt.toISOString()}`, s]),
    );
    const scheduleById = new Map(schedules.map((s) => [s.id, s]));

    type Row = {
      key: string;
      sessionId: string | null;
      scheduleId: string | null;
      serviceId: string;
      serviceName: string;
      color: string | null;
      staffId: string | null;
      staffName: string | null;
      startsAt: string;
      endsAt: string;
      capacity: number;
      status: string;
      bookedCount: number;
      expectedCount: number;
      spotsLeft: number;
      /** Cuántos van por encima del cupo (el cupo es guía, no tope). */
      overBy: number;
    };
    const rows: Row[] = [];

    const expectedFor = (
      scheduleId: string | null,
      day: string,
      booked: Set<string>,
    ) => {
      if (!scheduleId) return 0;
      const schedule = scheduleById.get(scheduleId);
      if (!schedule) return 0;
      return schedule.enrollments.filter(
        (e) =>
          dayOf(e.activeFrom)! <= day &&
          (!e.activeUntil || dayOf(e.activeUntil)! >= day) &&
          !booked.has(e.customerId),
      ).length;
    };

    for (const session of stored) {
      const day = calendarDayCO(session.startsAt);
      const booked = new Set(session.attendees.map((a) => a.customerId));
      const expected = expectedFor(session.scheduleId, day, booked);
      rows.push({
        key: session.id,
        sessionId: session.id,
        scheduleId: session.scheduleId,
        serviceId: session.serviceId,
        serviceName: session.service.name,
        color: session.service.color,
        staffId: session.staffId,
        staffName: session.staff?.name ?? null,
        startsAt: session.startsAt.toISOString(),
        endsAt: session.endsAt.toISOString(),
        capacity: session.capacity,
        status: session.status,
        bookedCount: booked.size,
        expectedCount: expected,
        spotsLeft: Math.max(0, session.capacity - booked.size - expected),
        overBy: Math.max(0, booked.size + expected - session.capacity),
      });
    }

    for (let day = from; day <= to; day = addCalendarDaysCO(day, 1)) {
      const weekday = weekdayOf(day);
      for (const schedule of schedules) {
        if (schedule.weekday !== weekday) continue;
        if (dayOf(schedule.activeFrom)! > day) continue;
        if (schedule.activeUntil && dayOf(schedule.activeUntil)! < day)
          continue;
        const startsAt = instantOf(day, schedule.startTime);
        if (storedKey.has(`${schedule.id}|${startsAt.toISOString()}`)) continue;
        const expected = expectedFor(schedule.id, day, new Set());
        rows.push({
          key: `${schedule.id}|${startsAt.toISOString()}`,
          sessionId: null,
          scheduleId: schedule.id,
          serviceId: schedule.serviceId,
          serviceName: schedule.service.name,
          color: schedule.service.color,
          staffId: schedule.staffId,
          staffName: schedule.staff?.name ?? null,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(
            startsAt.getTime() + schedule.durationMin * 60_000,
          ).toISOString(),
          capacity: schedule.capacity,
          status: 'SCHEDULED',
          bookedCount: 0,
          expectedCount: expected,
          spotsLeft: Math.max(0, schedule.capacity - expected),
          overBy: Math.max(0, expected - schedule.capacity),
        });
      }
    }

    return rows.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  /**
   * Quiénes van a una clase: los inscritos (con cita) y los esperados (con
   * inscripción fija y sin cita todavía), cada uno con si su plan lo cubre.
   */
  async roster(ctx: TenantContext, ref: BarberClassSessionRefDto) {
    const session = await this.resolveSession(ctx, ref);
    const day = calendarDayCO(session.startsAt);

    const [attendees, enrollments, service, staff] = await Promise.all([
      // Una clase que todavía no existe no tiene inscritos; la consulta con
      // un id imposible devuelve vacío sin perder el tipo de la fila.
      this.prisma.barberAppointment.findMany({
        where: {
          classSessionId: session.sessionId ?? '__none__',
          status: { notIn: FREED_STATUSES },
        },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          coveredByCharge: {
            select: { id: true, concept: true, sessionsTotal: true },
          },
          // El cobro de la clase suelta, si ya se hizo.
          charges: { where: { voidedAt: null }, select: { id: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.barberClassEnrollment.findMany({
        where: {
          scheduleId: session.scheduleId ?? '__none__',
          activeFrom: { lte: dateOf(day) },
          OR: [{ activeUntil: null }, { activeUntil: { gte: dateOf(day) } }],
        },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
        },
      }),
      this.prisma.barberService.findUniqueOrThrow({
        where: { id: session.serviceId },
        select: { name: true, color: true, priceCOP: true },
      }),
      session.staffId
        ? this.prisma.barberStaff.findUnique({
            where: { id: session.staffId },
            select: { name: true },
          })
        : Promise.resolve(null),
    ]);

    const booked = new Set(attendees.map((a) => a.customerId));
    const expected = enrollments.filter((e) => !booked.has(e.customerId));

    // Si su plan lo cubre ese día. Para los que ya tienen cita manda lo que
    // quedó marcado en la cita; para los esperados se calcula.
    const coverage = async (customerId: string) => {
      const charge = await this.charges.findCoveringCharge(
        this.prisma,
        ctx,
        customerId,
        day,
      );
      return charge
        ? {
            chargeId: charge.id,
            concept: charge.concept,
            sessionsLeft:
              charge.sessionsTotal === null
                ? null
                : charge.sessionsTotal - charge._count.coveredAppointments,
          }
        : null;
    };

    const attendeeRows = await Promise.all(
      attendees.map(async (a) => ({
        appointmentId: a.id,
        customerId: a.customerId,
        customerName: a.customer.name,
        customerPhone: a.customer.phone,
        status: a.status,
        attended: a.status.toUpperCase() === 'COMPLETED',
        absent: a.status.toUpperCase() === 'NO_SHOW',
        coverage: a.coveredByCharge
          ? {
              chargeId: a.coveredByCharge.id,
              concept: a.coveredByCharge.concept,
              sessionsLeft: null,
            }
          : await coverage(a.customerId),
        isCovered: !!a.coveredByCharge,
        chargeId: a.charges[0]?.id ?? null,
      })),
    );
    const expectedRows = await Promise.all(
      expected.map(async (e) => ({
        enrollmentId: e.id,
        customerId: e.customerId,
        customerName: e.customer.name,
        customerPhone: e.customer.phone,
        coverage: await coverage(e.customerId),
      })),
    );

    return {
      sessionId: session.sessionId,
      scheduleId: session.scheduleId,
      serviceId: session.serviceId,
      serviceName: service.name,
      color: service.color,
      priceCOP: service.priceCOP,
      staffId: session.staffId,
      staffName: staff?.name ?? null,
      startsAt: session.startsAt.toISOString(),
      endsAt: session.endsAt.toISOString(),
      capacity: session.capacity,
      status: session.status,
      bookedCount: attendees.length,
      expectedCount: expectedRows.length,
      spotsLeft: Math.max(
        0,
        session.capacity - attendees.length - expectedRows.length,
      ),
      overBy: Math.max(
        0,
        attendees.length + expectedRows.length - session.capacity,
      ),
      attendees: attendeeRows,
      expected: expectedRows,
    };
  }

  /**
   * Inscribe a alguien en una clase (y, si ya llegó, marca su asistencia). Si
   * la clase todavía no existe en la base, se crea aquí.
   *
   * EL CUPO NO ES UN TOPE. Pasarse se permite: el roster muestra "excede cupo
   * +N". El bloqueo de la clase sigue para que dos inscripciones simultáneas
   * de la misma persona no creen dos citas.
   */
  async addAttendee(ctx: TenantContext, dto: AddBarberClassAttendeeDto) {
    await this.tenantHelper.assertScopedRecord(
      'barberCustomer',
      ctx,
      dto.customerId,
      'Customer',
    );
    const resolved = await this.resolveSession(ctx, dto);
    if (resolved.status === 'CANCELLED') {
      throw new BadRequestException('La clase está cancelada');
    }

    const sessionId = await this.prisma.$transaction(async (tx) => {
      const id = await this.materialize(tx, ctx, resolved);
      await tx.$queryRaw`SELECT id FROM barber_class_sessions WHERE id = ${id} FOR UPDATE`;

      const attendees = await tx.barberAppointment.findMany({
        where: { classSessionId: id, status: { notIn: FREED_STATUSES } },
        select: { customerId: true },
      });
      if (attendees.some((a) => a.customerId === dto.customerId)) {
        throw new ConflictException({
          code: 'ALREADY_IN_CLASS',
          message: 'Ya está inscrito en esta clase',
        });
      }
      // El cupo es una guía, no un tope: pasarse se permite y el roster lo
      // marca ("excede cupo +N") para decidir si abrir otro horario.

      await this.createAttendance(tx, ctx, id, resolved, dto.customerId, {
        attended: !!dto.attended,
      });
      return id;
    });

    await this.syncVisits(dto.customerId);
    return this.roster(ctx, { sessionId });
  }

  /** Marca o desmarca la asistencia de un inscrito. */
  async setAttendance(
    ctx: TenantContext,
    appointmentId: string,
    attended: boolean,
  ) {
    const appt = await this.prisma.barberAppointment.findFirst({
      where: {
        id: appointmentId,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        classSessionId: { not: null },
      },
      include: { classSession: true },
    });
    if (!appt || !appt.classSession) {
      throw new NotFoundException(`Attendee ${appointmentId} not found`);
    }
    await this.prisma.$transaction((tx) =>
      this.applyAttendance(tx, ctx, appt, attended),
    );
    await this.syncVisits(appt.customerId);
    return this.roster(ctx, { sessionId: appt.classSessionId! });
  }

  /** Saca a alguien de la clase: su cita queda cancelada y el puesto libre. */
  async removeAttendee(ctx: TenantContext, appointmentId: string) {
    const appt = await this.prisma.barberAppointment.findFirst({
      where: {
        id: appointmentId,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        classSessionId: { not: null },
      },
      select: { customerId: true, classSessionId: true },
    });
    if (!appt)
      throw new NotFoundException(`Attendee ${appointmentId} not found`);
    await this.prisma.barberAppointment.update({
      where: { id: appointmentId },
      data: { status: 'CANCELLED', coveredByChargeId: null },
    });
    await this.syncVisits(appt.customerId);
    return this.roster(ctx, { sessionId: appt.classSessionId! });
  }

  /**
   * Pasar lista de una vez. Los que están en `presentCustomerIds` quedan con
   * asistencia (se les crea la cita si eran esperados); los inscritos que no
   * están quedan como ausentes. Pasar lista no mira el cupo: la gente ya vino.
   */
  async markAttendance(ctx: TenantContext, dto: MarkBarberClassAttendanceDto) {
    const resolved = await this.resolveSession(ctx, dto);
    const present = new Set(dto.presentCustomerIds);

    const touched = new Set<string>();
    const sessionId = await this.prisma.$transaction(async (tx) => {
      const id = await this.materialize(tx, ctx, resolved);
      const attendees = await tx.barberAppointment.findMany({
        where: { classSessionId: id, status: { notIn: FREED_STATUSES } },
        include: { classSession: true },
      });
      const booked = new Set(attendees.map((a) => a.customerId));

      for (const appt of attendees) {
        await this.applyAttendance(tx, ctx, appt, present.has(appt.customerId));
        touched.add(appt.customerId);
      }
      for (const customerId of present) {
        if (booked.has(customerId)) continue;
        await this.tenantHelper.assertScopedRecord(
          'barberCustomer',
          ctx,
          customerId,
          'Customer',
        );
        await this.createAttendance(tx, ctx, id, resolved, customerId, {
          attended: true,
        });
        touched.add(customerId);
      }
      return id;
    });

    for (const customerId of touched) await this.syncVisits(customerId);
    return this.roster(ctx, { sessionId });
  }

  // ─── Internos ──────────────────────────────────────────────────────────────

  /** Escribe un hecho en el historial del horario. La frase se congela. */
  private logEvent(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    scheduleId: string,
    event: { kind: string; summary: string; detail?: Prisma.InputJsonValue },
  ) {
    return tx.barberClassScheduleEvent.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        scheduleId,
        kind: event.kind,
        summary: event.summary,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        userId: ctx.userId,
        userName: ctx.name,
      },
    });
  }

  /** "17:00 → 18:00 · cupo 10 → 12": lo que cambia, para el historial. */
  private describeChanges(
    before: {
      startTime: string;
      durationMin: number;
      capacity: number;
      staffId: string | null;
    },
    after: {
      startTime: string;
      durationMin: number;
      capacity: number;
      staffId: string | null;
    },
  ): string[] {
    const out: string[] = [];
    if (before.startTime !== after.startTime)
      out.push(`hora ${before.startTime} → ${after.startTime}`);
    if (before.durationMin !== after.durationMin)
      out.push(`duración ${before.durationMin} → ${after.durationMin} min`);
    if (before.capacity !== after.capacity)
      out.push(`cupo ${before.capacity} → ${after.capacity}`);
    if (before.staffId !== after.staffId) out.push('cambio de entrenador');
    return out;
  }

  private async findSchedule(ctx: TenantContext, id: string) {
    const row = await this.prisma.barberClassSchedule.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
    if (!row) throw new NotFoundException(`Class schedule ${id} not found`);
    return row;
  }

  /** La clase pedida: la guardada o la que sale del horario a esa hora. */
  private async resolveSession(
    ctx: TenantContext,
    ref: BarberClassSessionRefDto,
  ): Promise<ResolvedSession> {
    if (ref.sessionId) {
      const s = await this.prisma.barberClassSession.findFirst({
        where: {
          id: ref.sessionId,
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
        },
      });
      if (!s) throw new NotFoundException(`Class ${ref.sessionId} not found`);
      return {
        sessionId: s.id,
        scheduleId: s.scheduleId,
        serviceId: s.serviceId,
        staffId: s.staffId,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        capacity: s.capacity,
        status: s.status,
      };
    }
    if (!ref.scheduleId || !ref.startsAt) {
      throw new BadRequestException(
        'Falta la clase (sessionId o horario + hora)',
      );
    }
    const schedule = (await this.prisma.barberClassSchedule.findFirst({
      where: {
        id: ref.scheduleId,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
      },
      include: {
        service: {
          select: { id: true, name: true, color: true, priceCOP: true },
        },
        staff: { select: { id: true, name: true } },
      },
    })) as ScheduleRow | null;
    if (!schedule) {
      throw new NotFoundException(`Class schedule ${ref.scheduleId} not found`);
    }
    const startsAt = new Date(ref.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException('Hora de la clase inválida');
    }
    const day = calendarDayCO(startsAt);
    // La hora tiene que ser una que el horario de verdad genera: si no,
    // cualquiera podría inventar una clase el martes a las 3 a.m.
    if (
      weekdayOf(day) !== schedule.weekday ||
      instantOf(day, schedule.startTime).getTime() !== startsAt.getTime()
    ) {
      throw new BadRequestException('Esa hora no corresponde al horario');
    }

    const stored = await this.prisma.barberClassSession.findUnique({
      where: {
        scheduleId_startsAt: { scheduleId: schedule.id, startsAt },
      },
    });
    if (stored) {
      return this.resolveSession(ctx, { sessionId: stored.id });
    }
    return {
      sessionId: null,
      scheduleId: schedule.id,
      serviceId: schedule.serviceId,
      staffId: schedule.staffId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + schedule.durationMin * 60_000),
      capacity: schedule.capacity,
      status: 'SCHEDULED',
    };
  }

  /** Guarda la clase si todavía no existe. Devuelve su id. */
  private async materialize(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    session: ResolvedSession,
  ): Promise<string> {
    if (session.sessionId) return session.sessionId;
    const row = await tx.barberClassSession.upsert({
      where: {
        scheduleId_startsAt: {
          scheduleId: session.scheduleId!,
          startsAt: session.startsAt,
        },
      },
      create: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        scheduleId: session.scheduleId,
        serviceId: session.serviceId,
        staffId: session.staffId,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        capacity: session.capacity,
      },
      update: {},
    });
    return row.id;
  }

  /** La cita de un asistente. Si su plan lo cubre, queda marcada. */
  private async createAttendance(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
    session: ResolvedSession,
    customerId: string,
    opts: { attended: boolean },
  ) {
    const day = calendarDayCO(session.startsAt);
    const covering = await this.charges.findCoveringCharge(
      tx,
      ctx,
      customerId,
      day,
    );
    const service = await tx.barberService.findUniqueOrThrow({
      where: { id: session.serviceId },
      select: { priceCOP: true },
    });
    return tx.barberAppointment.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        customerId,
        serviceId: session.serviceId,
        staffId: session.staffId,
        scheduledAt: session.startsAt,
        scheduledEnd: session.endsAt,
        source: 'class',
        classSessionId: sessionId,
        coveredByChargeId: covering?.id ?? null,
        status: opts.attended ? 'COMPLETED' : 'CONFIRMED',
        ...(opts.attended
          ? {
              servedAt: session.startsAt,
              // Cubierta por el plan = no se cobró aparte. Suelta = el precio
              // de la clase, que se cobra con un cobro (Finanzas no cuenta las
              // asistencias como venta).
              priceCOP: covering ? 0 : service.priceCOP,
              costCOP: 0,
            }
          : {}),
      },
    });
  }

  /**
   * Asistió o no. Si asistió y todavía no la cubre un plan, se busca uno: pudo
   * haber pagado la mensualidad después de inscribirse.
   */
  private async applyAttendance(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    appt: {
      id: string;
      customerId: string;
      serviceId: string;
      coveredByChargeId: string | null;
      classSession: { startsAt: Date } | null;
    },
    attended: boolean,
  ) {
    if (!attended) {
      return tx.barberAppointment.update({
        where: { id: appt.id },
        data: { status: 'NO_SHOW', servedAt: null },
      });
    }
    const startsAt = appt.classSession!.startsAt;
    const coveredByChargeId =
      appt.coveredByChargeId ??
      (
        await this.charges.findCoveringCharge(
          tx,
          ctx,
          appt.customerId,
          calendarDayCO(startsAt),
        )
      )?.id ??
      null;
    const service = await tx.barberService.findUniqueOrThrow({
      where: { id: appt.serviceId },
      select: { priceCOP: true },
    });
    return tx.barberAppointment.update({
      where: { id: appt.id },
      data: {
        status: 'COMPLETED',
        servedAt: startsAt,
        coveredByChargeId,
        priceCOP: coveredByChargeId ? 0 : service.priceCOP,
        costCOP: 0,
      },
    });
  }

  /** Visitas y última visita del cliente, recalculadas (no incrementadas). */
  private syncVisits(customerId: string) {
    return this.prisma.$transaction((tx) =>
      this.appointments.syncCustomerVisits(tx, customerId),
    );
  }
}
