import { BadRequestException, Injectable } from '@nestjs/common';
import { BarberAppointmentEventKind, Prisma } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  CO_UTC_OFFSET,
  calendarDayCO,
  clockTimeCO,
  formatCOP,
} from '../../../common/date.util';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import {
  COMPLETED_STATUS_VARIANTS,
  isCompletedStatus,
} from '../../shared/appointment-status';
import {
  CancelBarberAppointmentDto,
  CreateBarberAppointmentDto,
  UpdateBarberAppointmentDto,
  UpdateBarberAppointmentServedAtDto,
} from './dto/barber-appointment.dto';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class BarberAppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
  ) {}

  async listAppointments(ctx: TenantContext) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    return this.prisma.barberAppointment.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: { customer: true, service: true, staff: true },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  async createAppointment(ctx: TenantContext, dto: CreateBarberAppointmentDto) {
    await this.assertAppointmentRelations(ctx, {
      customerId: dto.customerId,
      serviceId: dto.serviceId,
      staffId: dto.staffId,
    });

    const service = await this.prisma.barberService.findUniqueOrThrow({
      where: { id: dto.serviceId },
      select: { durationMin: true },
    });
    const durationMin = dto.durationMinutes ?? service.durationMin;
    const scheduledAt = new Date(dto.scheduledAt);
    const scheduledEnd = new Date(scheduledAt.getTime() + durationMin * 60_000);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.barberAppointment.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          customerId: dto.customerId,
          serviceId: dto.serviceId,
          staffId: dto.staffId,
          scheduledAt,
          scheduledEnd,
          notes: dto.notes,
        },
        include: { customer: true, service: true, staff: true },
      });

      await this.logAppointmentEvent(tx, ctx, created.id, {
        kind: 'CREATED',
        summary: `Cita agendada para el ${calendarDayCO(scheduledAt)}`,
        detail: { scheduledAt: scheduledAt.toISOString() },
      });

      return created;
    });
  }

  async updateAppointment(
    ctx: TenantContext,
    id: string,
    dto: UpdateBarberAppointmentDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'barberAppointment',
      ctx,
      id,
      'Appointment',
    );
    await this.assertAppointmentRelations(ctx, {
      customerId: dto.customerId,
      serviceId: dto.serviceId,
      staffId: dto.staffId,
    });

    const current = await this.prisma.barberAppointment.findUniqueOrThrow({
      where: { id },
      select: {
        serviceId: true,
        customerId: true,
        status: true,
        priceCOP: true,
        servedAt: true,
        scheduledAt: true,
      },
    });
    const serviceId = dto.serviceId ?? current.serviceId;
    const service = await this.prisma.barberService.findUniqueOrThrow({
      where: { id: serviceId },
      select: { durationMin: true, priceCOP: true, costCOP: true },
    });
    const durationMin = dto.durationMinutes ?? service.durationMin;
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : undefined;

    // Al completar, se congelan precio y costo del servicio. Sin esto el ingreso
    // se lee del BarberService ACTUAL y reprecio o renombrar reescribe el
    // histórico entero. Solo se congela la primera vez (priceCOP aún null).
    const completesNow =
      isCompletedStatus(dto.status) && current.priceCOP === null;

    // Cuándo se prestó el servicio. Por defecto es el día agendado, que es la
    // verdad en el caso normal; si lo registran después ("fue hace ocho días"),
    // el dto lo trae, y si no, se corrige luego con `updateServedAt`.
    const servedAt = completesNow
      ? this.resolveServedAt(dto.servedAt ?? undefined, current.scheduledAt)
      : undefined;

    // El cambio de estado y los contadores del cliente van en la MISMA
    // transacción: si una falla, ninguna pasa, o el contador de visitas queda
    // diciendo algo distinto del histórico que lo sustenta.
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.barberAppointment.update({
        where: { id },
        data: {
          customerId: dto.customerId,
          serviceId: dto.serviceId,
          staffId: dto.staffId,
          scheduledAt,
          scheduledEnd: scheduledAt
            ? new Date(scheduledAt.getTime() + durationMin * 60_000)
            : undefined,
          status: dto.status,
          notes: dto.notes,
          ...(completesNow
            ? {
                priceCOP: service.priceCOP,
                costCOP: service.costCOP,
                servedAt,
              }
            : {}),
        },
        include: { customer: true, service: true, staff: true },
      });

      if (completesNow) {
        await this.logAppointmentEvent(tx, ctx, id, {
          kind: 'COMPLETED',
          summary: `Servicio prestado el ${calendarDayCO(servedAt!)} · ${formatCOP(service.priceCOP)}`,
          detail: {
            servedAt: servedAt!.toISOString(),
            priceCOP: service.priceCOP,
            costCOP: service.costCOP,
          },
        });
      }

      // Se recalculan siempre, no solo al completar: este mismo endpoint puede
      // descompletar una cita (volverla a CANCELLED) o moverla a otro cliente, y
      // en los dos casos las visitas de alguien cambiaron.
      await this.syncCustomerVisits(tx, current.customerId);
      if (dto.customerId && dto.customerId !== current.customerId) {
        await this.syncCustomerVisits(tx, dto.customerId);
      }

      return updated;
    });
  }

  /**
   * Corrige el día en que se prestó un servicio.
   *
   * EL CASO. Se atendió hace ocho días y no hubo tiempo de registrarlo; se
   * digita hoy y queda pesando en el día equivocado, porque los reportes y la
   * lista de retoques cuentan por `servedAt`. Sin esto la única salida era
   * borrar la cita y volver a crearla, que le borra el histórico al cliente.
   *
   * SE PUEDE AUNQUE LA CITA YA ESTÉ COMPLETADA. Corregir la fecha no deshace
   * nada: el servicio se prestó igual, lo único que estaba mal era el día
   * anotado. Bloquearlo dejaría el error escrito para siempre.
   *
   * LO QUE NO SE MUEVE: `createdAt`, que es la auditoría de cuándo se digitó, y
   * `scheduledAt`, que es lo que quedó en la agenda ese día. Son dos hechos
   * distintos y ninguno de los dos se reescribe.
   */
  async updateServedAt(
    ctx: TenantContext,
    id: string,
    dto: UpdateBarberAppointmentServedAtDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'barberAppointment',
      ctx,
      id,
      'Appointment',
    );

    const current = await this.prisma.barberAppointment.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        servedAt: true,
        scheduledAt: true,
        customerId: true,
      },
    });
    if (!isCompletedStatus(current.status)) {
      throw new BadRequestException(
        'La cita no está completada: todavía no hay fecha de servicio que corregir',
      );
    }

    const servedAt = this.resolveServedAt(dto.servedAt, current.scheduledAt);
    const previous = current.servedAt ?? current.scheduledAt;
    if (calendarDayCO(servedAt) === calendarDayCO(previous)) {
      throw new BadRequestException('El servicio ya está en ese día');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.barberAppointment.update({
        where: { id },
        data: { servedAt },
        include: { customer: true, service: true, staff: true },
      });

      await this.logAppointmentEvent(tx, ctx, id, {
        kind: 'DATE_CHANGED',
        summary: `Fecha del servicio corregida: ${calendarDayCO(previous)} → ${calendarDayCO(servedAt)}`,
        note: dto.reason,
        detail: {
          from: previous.toISOString(),
          to: servedAt.toISOString(),
        },
      });

      // Obligatorio recalcular, no comparar: si se corrige HACIA ATRÁS justo la
      // fecha que era la más reciente, la última visita del cliente pasa a ser
      // otra cita distinta, y un simple `max(actual, nueva)` la dejaría mal.
      await this.syncCustomerVisits(tx, current.customerId);

      return updated;
    });
  }

  /** Histórico auditable de una cita, del más reciente al más viejo. */
  async listEvents(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord(
      'barberAppointment',
      ctx,
      id,
      'Appointment',
    );
    return this.prisma.barberAppointmentEvent.findMany({
      where: { appointmentId: id },
      orderBy: { occurredAt: 'desc' },
    });
  }

  async cancelAppointment(
    ctx: TenantContext,
    id: string,
    dto: CancelBarberAppointmentDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'barberAppointment',
      ctx,
      id,
      'Appointment',
    );
    const current = await this.prisma.barberAppointment.findUniqueOrThrow({
      where: { id },
      select: { customerId: true, status: true },
    });

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.barberAppointment.update({
        where: { id },
        data: { status: 'CANCELLED', cancelReason: dto.reason },
        include: { customer: true, service: true, staff: true },
      });

      await this.logAppointmentEvent(tx, ctx, id, {
        kind: 'CANCELLED',
        summary: 'Cita cancelada',
        note: dto.reason,
      });

      // Cancelar una cita que ya estaba completada le quita una visita al
      // cliente. Sin esto el contador infla y los bonos de lealtad se disparan
      // por servicios que nunca se prestaron.
      await this.syncCustomerVisits(tx, current.customerId);

      return updated;
    });
  }

  // Aprueba un agendamiento pendiente: queda confirmado y ocupa el slot.
  async approveAppointment(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord(
      'barberAppointment',
      ctx,
      id,
      'Appointment',
    );
    return this.prisma.barberAppointment.update({
      where: { id },
      data: { status: 'CONFIRMED' },
      include: { customer: true, service: true, staff: true },
    });
  }

  // Rechaza un agendamiento: libera el slot (REJECTED no cuenta en conflictos)
  // y persiste el motivo en cancelReason para tener el histórico del porqué.
  async rejectAppointment(ctx: TenantContext, id: string, reason: string) {
    await this.tenantHelper.assertScopedRecord(
      'barberAppointment',
      ctx,
      id,
      'Appointment',
    );
    const current = await this.prisma.barberAppointment.findUniqueOrThrow({
      where: { id },
      select: { customerId: true },
    });

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.barberAppointment.update({
        where: { id },
        data: { status: 'REJECTED', cancelReason: reason },
        include: { customer: true, service: true, staff: true },
      });

      await this.logAppointmentEvent(tx, ctx, id, {
        kind: 'CANCELLED',
        summary: 'Agendamiento rechazado',
        note: reason,
      });
      await this.syncCustomerVisits(tx, current.customerId);

      return updated;
    });
  }

  // Elimina definitivamente un agendamiento (acción del admin).
  async deleteAppointment(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord(
      'barberAppointment',
      ctx,
      id,
      'Appointment',
    );
    const current = await this.prisma.barberAppointment.findUniqueOrThrow({
      where: { id },
      select: { customerId: true },
    });

    // Borrar una cita completada también le quita la visita al cliente. Los
    // eventos se van con ella por el `onDelete: Cascade`.
    await this.prisma.$transaction(async (tx) => {
      await tx.barberAppointment.delete({ where: { id } });
      await this.syncCustomerVisits(tx, current.customerId);
    });
    return { ok: true };
  }

  /**
   * Deja `totalVisits` y `lastVisitAt` del cliente diciendo exactamente lo que
   * dicen sus citas.
   *
   * SE RECALCULA, NO SE INCREMENTA. Un contador que se suma y se resta a mano se
   * desincroniza en cuanto aparece un camino que alguien olvidó cubrir —
   * descompletar, cambiar de cliente, corregir una fecha hacia atrás, borrar una
   * cita— y el error es silencioso: nadie nota que un cliente tiene una visita
   * de más hasta que se le dispara un bono de lealtad que no le tocaba. Un
   * agregado sobre una columna indexada es barato y no puede quedar mal.
   *
   * SOLO CUENTAN LOS SERVICIOS REALIZADOS. Canceladas, rechazadas, no-show y
   * pendientes no suman: un no-show no es un servicio prestado.
   */
  private async syncCustomerVisits(
    tx: Prisma.TransactionClient,
    customerId: string,
  ) {
    const agg = await tx.barberAppointment.aggregate({
      where: {
        customerId,
        status: { in: COMPLETED_STATUS_VARIANTS },
      },
      _count: { _all: true },
      _max: { servedAt: true },
    });

    await tx.barberCustomer.update({
      where: { id: customerId },
      data: {
        totalVisits: agg._count._all,
        lastVisitAt: agg._max.servedAt ?? null,
      },
    });
  }

  /**
   * Escribe un hecho en el histórico de la cita.
   *
   * El resumen se congela ya escrito: el histórico de una cita vieja tiene que
   * seguir diciendo lo que decía aunque la lógica cambie después. Y el autor se
   * guarda por nombre además de por id, porque el histórico no puede depender de
   * que el usuario siga existiendo.
   */
  private logAppointmentEvent(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    appointmentId: string,
    event: {
      kind: BarberAppointmentEventKind;
      summary: string;
      note?: string | null;
      detail?: Prisma.InputJsonValue;
    },
  ) {
    return tx.barberAppointmentEvent.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        appointmentId,
        kind: event.kind,
        summary: event.summary,
        note: event.note ?? null,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        userId: ctx.userId,
        userName: ctx.name,
      },
    });
  }

  /**
   * Resuelve la fecha en que se prestó el servicio.
   *
   * Una fecha sin hora ('2026-09-01') se ancla a la hora actual de Colombia, no
   * a medianoche: así el servicio cae dentro del día que se quiso y no en el
   * borde, donde un corrimiento de zona horaria lo pasaría al día anterior.
   * Sin dato, manda el día agendado, que es la verdad en el caso normal.
   */
  private resolveServedAt(value: string | undefined, fallback: Date): Date {
    if (!value) return fallback;

    const now = new Date();
    const parsed = DATE_ONLY_RE.test(value)
      ? new Date(`${value}T${clockTimeCO(now)}${CO_UTC_OFFSET}`)
      : new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Fecha inválida: ${value}`);
    }
    if (calendarDayCO(parsed) > calendarDayCO(now)) {
      throw new BadRequestException(
        'No se puede registrar un servicio prestado en el futuro',
      );
    }
    return parsed;
  }

  private async assertAppointmentRelations(
    ctx: TenantContext,
    ids: { customerId?: string; serviceId?: string; staffId?: string },
  ) {
    await Promise.all([
      ids.customerId
        ? this.tenantHelper.assertScopedRecord(
            'barberCustomer',
            ctx,
            ids.customerId,
            'Customer',
          )
        : Promise.resolve(),
      ids.serviceId
        ? this.tenantHelper.assertScopedRecord(
            'barberService',
            ctx,
            ids.serviceId,
            'Service',
          )
        : Promise.resolve(),
      ids.staffId
        ? this.tenantHelper.assertScopedRecord(
            'barberStaff',
            ctx,
            ids.staffId,
            'Staff',
          )
        : Promise.resolve(),
    ]);
  }
}
