import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
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
import { assertSlotFree, findSlotClashes } from '../../shared/slot-conflict';
import {
  minutesBetween,
  priceForMinutes,
  storedPriceForDuration,
} from '../../shared/duration-price';
import { ensureRecurringHorizon } from '../../shared/recurring-horizon';
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
    // Completa hacia adelante las reservas fijas antes de pintar la agenda.
    await ensureRecurringHorizon(this.prisma, ctx.branchId);
    return this.prisma.barberAppointment.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: { customer: true, service: true, staff: true },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  async createAppointment(ctx: TenantContext, dto: CreateBarberAppointmentDto) {
    // Sin cliente: solo dueño o gerente, y con una nota que diga quién es. Lo
    // ideal es registrarlo siempre; esto es para cuando no hay datos todavía.
    const customerId = dto.customerId?.trim() || null;
    const notes = dto.notes?.trim() || undefined;
    if (!customerId) {
      const canSkipCustomer =
        ctx.isRoot || ['OWNER', 'MANAGER'].includes(ctx.roleCode);
      if (!canSkipCustomer) {
        throw new ForbiddenException(
          'Solo el dueño o el gerente pueden agendar sin cliente.',
        );
      }
      if (!notes) {
        throw new BadRequestException({
          code: 'CUSTOMER_NOTE_REQUIRED',
          message:
            'Sin cliente registrado, escribe una nota (nombre, teléfono o quién es).',
        });
      }
    }

    await this.assertAppointmentRelations(ctx, {
      customerId: customerId ?? undefined,
      serviceId: dto.serviceId,
      staffId: dto.staffId,
    });

    const service = await this.prisma.barberService.findUniqueOrThrow({
      where: { id: dto.serviceId },
      select: { durationMin: true, priceCOP: true, durationOptions: true },
    });
    const durationMin = dto.durationMinutes ?? service.durationMin;
    const scheduledAt = new Date(dto.scheduledAt);
    const scheduledEnd = new Date(scheduledAt.getTime() + durationMin * 60_000);
    // Reserva por bloques (2 h de cancha): se guarda el precio de ESA duración.
    // En la duración base queda null y manda el precio del servicio.
    const priceCOP = storedPriceForDuration(service, durationMin);

    return this.prisma.$transaction(async (tx) => {
      // Misma regla que la reserva pública: el espacio (especialista, o el
      // servicio si no hay especialista) no se puede tomar dos veces.
      assertSlotFree(
        await findSlotClashes(tx, {
          branchId: ctx.branchId,
          staffId: dto.staffId,
          serviceId: dto.serviceId,
          start: scheduledAt,
          end: scheduledEnd,
        }),
        { allowOverPending: dto.allowOverPending },
      );

      const created = await tx.barberAppointment.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          customerId,
          serviceId: dto.serviceId,
          staffId: dto.staffId,
          scheduledAt,
          scheduledEnd,
          priceCOP,
          notes,
        },
        include: { customer: true, service: true, staff: true },
      });

      await this.logAppointmentEvent(tx, ctx, created.id, {
        kind: 'CREATED',
        summary: `Agendada para el ${calendarDayCO(scheduledAt)}${customerId ? '' : ' (sin cliente registrado)'}`,
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
        staffId: true,
        status: true,
        priceCOP: true,
        costCOP: true,
        servedAt: true,
        scheduledAt: true,
        scheduledEnd: true,
        recurringBookingId: true,
      },
    });
    const serviceId = dto.serviceId ?? current.serviceId;
    const service = await this.prisma.barberService.findUniqueOrThrow({
      where: { id: serviceId },
      select: {
        durationMin: true,
        priceCOP: true,
        costCOP: true,
        durationOptions: true,
      },
    });
    const durationMin = dto.durationMinutes ?? service.durationMin;
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : undefined;

    // Al completar, se congelan precio y costo del servicio. Sin esto el ingreso
    // se lee del BarberService ACTUAL y reprecio o renombrar reescribe el
    // histórico entero. Solo la primera vez: todavía sin fecha de servicio.
    //
    // Una reserva fija trae su PRECIO PACTADO desde que se crea (precio de
    // equipo): ese se conserva. Antes la condición era "priceCOP todavía null",
    // y con el precio ya puesto la cita nunca guardaba su fecha de servicio.
    const completesNow =
      isCompletedStatus(dto.status) &&
      !isCompletedStatus(current.status) &&
      (current.priceCOP === null || current.servedAt === null);

    // Cuándo se prestó el servicio. Por defecto es el día agendado, que es la
    // verdad en el caso normal; si lo registran después ("fue hace ocho días"),
    // el dto lo trae, y si no, se corrige luego con `updateServedAt`.
    const servedAt = completesNow
      ? this.resolveServedAt(dto.servedAt ?? undefined, current.scheduledAt)
      : undefined;

    // El cambio de estado y los contadores del cliente van en la MISMA
    // transacción: si una falla, ninguna pasa, o el contador de visitas queda
    // diciendo algo distinto del histórico que lo sustenta.
    // Mover la cita (hora, duración, especialista o servicio) vuelve a validar
    // el espacio. Cambiar solo el estado o la nota no.
    const moves =
      !!dto.scheduledAt ||
      dto.durationMinutes !== undefined ||
      (dto.staffId !== undefined && dto.staffId !== current.staffId) ||
      (dto.serviceId !== undefined && dto.serviceId !== current.serviceId);
    const nextStart = scheduledAt ?? current.scheduledAt;
    const nextEnd =
      scheduledAt || dto.durationMinutes !== undefined || dto.serviceId
        ? new Date(nextStart.getTime() + durationMin * 60_000)
        : current.scheduledEnd;
    const freesSlot = [
      'CANCELLED',
      'REJECTED',
      'NO_SHOW',
      'COMPLETED',
    ].includes((dto.status ?? current.status).toUpperCase());
    // Una sesión que ya empezó y solo se alargó (misma hora de inicio) es
    // registrar lo que pasó, no reservar: no se bloquea. Moverla a otra hora sí
    // valida el espacio nuevo.
    const sameStart =
      !scheduledAt || scheduledAt.getTime() === current.scheduledAt.getTime();
    const extendsStartedSession =
      sameStart &&
      (dto.staffId === undefined || dto.staffId === current.staffId) &&
      current.scheduledAt.getTime() <= Date.now();

    // Precio de la duración nueva. Alargar 1 h → 2 h en una cancha de
    // $30.000/h deja la reserva en $60.000. No se toca una completada (su precio
    // ya quedó congelado) ni una reserva fija (trae su precio pactado).
    const nextMinutes = minutesBetween(nextStart, nextEnd);
    const durationChanged =
      nextMinutes !==
        minutesBetween(current.scheduledAt, current.scheduledEnd) ||
      serviceId !== current.serviceId;
    const reprice =
      moves &&
      durationChanged &&
      !isCompletedStatus(current.status) &&
      !current.recurringBookingId;
    const priceAfterMove = reprice
      ? storedPriceForDuration(service, nextMinutes)
      : current.priceCOP;
    // Al completar: lo guardado, o el precio de la duración REAL (antes era
    // siempre el del servicio, o sea el de un solo bloque).
    const frozenPrice = priceAfterMove ?? priceForMinutes(service, nextMinutes);

    return this.prisma.$transaction(async (tx) => {
      if (moves && !freesSlot && !extendsStartedSession) {
        assertSlotFree(
          await findSlotClashes(tx, {
            branchId: ctx.branchId,
            staffId: dto.staffId ?? current.staffId,
            serviceId,
            start: nextStart,
            end: nextEnd,
            excludeId: id,
          }),
          { allowOverPending: dto.allowOverPending },
        );
      }

      const updated = await tx.barberAppointment.update({
        where: { id },
        data: {
          customerId: dto.customerId,
          serviceId: dto.serviceId,
          staffId: dto.staffId,
          scheduledAt,
          // También cuando solo cambia la duración (antes se ignoraba si no
          // venía la hora de inicio).
          scheduledEnd:
            nextEnd.getTime() !== current.scheduledEnd.getTime()
              ? nextEnd
              : undefined,
          status: dto.status,
          notes: dto.notes,
          ...(reprice && !completesNow ? { priceCOP: priceAfterMove } : {}),
          ...(completesNow
            ? {
                priceCOP: frozenPrice,
                costCOP: current.costCOP ?? service.costCOP,
                servedAt,
              }
            : {}),
        },
        include: { customer: true, service: true, staff: true },
      });

      if (completesNow) {
        await this.logAppointmentEvent(tx, ctx, id, {
          kind: 'COMPLETED',
          summary: `Servicio prestado el ${calendarDayCO(servedAt!)} · ${formatCOP(frozenPrice)}`,
          detail: {
            servedAt: servedAt!.toISOString(),
            priceCOP: frozenPrice,
            costCOP: current.costCOP ?? service.costCOP,
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
    const current = await this.prisma.barberAppointment.findUniqueOrThrow({
      where: { id },
      select: {
        staffId: true,
        serviceId: true,
        scheduledAt: true,
        scheduledEnd: true,
      },
    });
    return this.prisma.$transaction(async (tx) => {
      // Solo una reserva puede quedarse con el espacio: si ya hay otra
      // confirmada ahí, esta no se aprueba (se rechaza o se mueve).
      const clashes = await findSlotClashes(tx, {
        branchId: ctx.branchId,
        staffId: current.staffId,
        serviceId: current.serviceId,
        start: current.scheduledAt,
        end: current.scheduledEnd,
        excludeId: id,
      });
      assertSlotFree(
        { confirmed: clashes.confirmed, pending: [] },
        { allowOverPending: true },
      );
      return tx.barberAppointment.update({
        where: { id },
        data: { status: 'CONFIRMED' },
        include: { customer: true, service: true, staff: true },
      });
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
  // Público: el borrado de un servicio con su historial también se lleva citas.
  async syncCustomerVisits(
    tx: Prisma.TransactionClient,
    customerId: string | null,
  ) {
    // Cita sin cliente registrado: no hay a quién contarle la visita.
    if (!customerId) return;
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
