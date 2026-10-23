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
  calendarDayCO,
  clockTimeCO,
  dayEndCO,
  dayStartCO,
} from '../../../common/date.util';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import { COMPLETED_STATUS_VARIANTS } from '../../shared/appointment-status';
import {
  BarberPaymentInputDto,
  CreateBarberChargeDto,
  FreezeBarberChargeDto,
  ListBarberChargesQueryDto,
  ListBarberMembershipsQueryDto,
  RenewBarberChargeDto,
  UpdateBarberChargeDto,
} from './dto/barber-charge.dto';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Estados de cita que NO gastan una sesión del paquete: lo que no se prestó no
 * se descuenta. `status` es texto libre con variantes de mayúsculas.
 */
const NOT_CONSUMED_STATUSES = [
  'CANCELLED',
  'cancelled',
  'REJECTED',
  'rejected',
  'NO_SHOW',
  'no_show',
];

const CHARGE_INCLUDE = {
  payments: { orderBy: { paidAt: 'asc' } },
  customer: { select: { id: true, name: true, phone: true } },
  service: {
    select: {
      id: true,
      name: true,
      color: true,
      kind: true,
      validityDays: true,
      sessionsIncluded: true,
      priceCOP: true,
    },
  },
  _count: {
    select: {
      coveredAppointments: {
        where: { status: { notIn: NOT_CONSUMED_STATUSES } },
      },
    },
  },
} satisfies Prisma.BarberChargeInclude;

type ChargeRow = Prisma.BarberChargeGetPayload<{
  include: typeof CHARGE_INCLUDE;
}>;

/**
 * En qué va el cobro. Se DERIVA, no se guarda: un estado guardado se
 * desincroniza en cuanto alguien anula un pago y nadie lo recalcula.
 *
 * - PAID: no debe nada.
 * - IN_TERM: debe, pero su compromiso de pago todavía no llega. Es el caso del
 *   cliente que arrancó el 2 y paga el 7: del 2 al 7 no está "debiendo".
 * - DUE_TODAY: el compromiso es hoy.
 * - OVERDUE: pasó la fecha comprometida y sigue debiendo.
 * - PENDING: debe y no tiene fecha comprometida (se esperaba de contado).
 * - VOIDED: anulado.
 */
export type BarberChargeStatus =
  | 'PAID'
  | 'IN_TERM'
  | 'DUE_TODAY'
  | 'OVERDUE'
  | 'PENDING'
  | 'VOIDED';

/** Fecha calendario de una columna DATE, sin pasar por la zona horaria. */
function dayOf(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function addDays(day: string, n: number): string {
  const d = dateOf(day);
  d.setUTCDate(d.getUTCDate() + n);
  return dayOf(d)!;
}

/** Días calendario entre dos fechas 'YYYY-MM-DD' (b − a). */
function daysBetween(a: string, b: string): number {
  return Math.round((dateOf(b).getTime() - dateOf(a).getTime()) / 86_400_000);
}

/**
 * Cómo va la membresía de un cliente, mirando su plan o paquete vigente.
 * - ACTIVE: vigente y con sesiones (si las cuenta).
 * - EXPIRING: vence dentro de la ventana de aviso.
 * - EXPIRED: se le acabó la vigencia.
 * - NO_SESSIONS: vigente, pero ya usó todas sus sesiones.
 * - UPCOMING: pagó, pero todavía no arranca.
 */
export type BarberMembershipState =
  | 'ACTIVE'
  | 'EXPIRING'
  | 'EXPIRED'
  | 'NO_SESSIONS'
  | 'UPCOMING';

@Injectable()
export class BarberChargesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
  ) {}

  async list(ctx: TenantContext, query: ListBarberChargesQueryDto) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);

    const where: Prisma.BarberChargeWhereInput = {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
    };
    // Un cobro entra al rango si se hizo en él o si recibió plata en él: la
    // mensualidad de septiembre que se terminó de pagar en octubre también es
    // parte de lo que pasó en octubre.
    if (query.from || query.to) {
      const window = this.window(query.from, query.to);
      where.OR = [
        { chargedAt: window },
        { payments: { some: { paidAt: window, voidedAt: null } } },
      ];
    }

    const rows = await this.prisma.barberCharge.findMany({
      where,
      include: CHARGE_INCLUDE,
      orderBy: { chargedAt: 'desc' },
      take: 1000,
    });

    const today = calendarDayCO(new Date());
    const charges = rows.map((row) => this.toDto(row, today));
    return query.status === 'open'
      ? charges.filter((c) => c.balanceCOP > 0)
      : charges;
  }

  /**
   * Los números del período para la pantalla de cobros: cuánto entró, cuántos
   * pagos, qué se contrató y quién debe.
   *
   * LO QUE SE DEBE NO TIENE PERÍODO. "Por cobrar" es la foto de hoy de todos los
   * cobros abiertos: una deuda de agosto sigue siendo deuda en octubre, y
   * filtrarla por el mes la haría desaparecer de la vista.
   */
  async summary(ctx: TenantContext, from?: string, to?: string) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    const window = this.window(from, to);
    const scope = { tenantId: ctx.tenantId, branchId: ctx.branchId };

    const [payments, charges, open, uncharged] = await Promise.all([
      this.prisma.barberPayment.findMany({
        where: {
          ...scope,
          voidedAt: null,
          paidAt: window,
          charge: { voidedAt: null },
        },
        select: { amountCOP: true, method: true },
      }),
      this.prisma.barberCharge.findMany({
        where: { ...scope, voidedAt: null, chargedAt: window },
        include: CHARGE_INCLUDE,
      }),
      this.prisma.barberCharge.findMany({
        where: { ...scope, voidedAt: null },
        include: CHARGE_INCLUDE,
      }),
      // Citas completadas SIN cobro: Finanzas las sigue contando como ingreso
      // (precio congelado, el día del servicio). Van aquí para que esta
      // pantalla y el dashboard digan la misma cifra, y para poder cobrarlas.
      this.prisma.barberAppointment.findMany({
        where: {
          ...scope,
          status: { in: COMPLETED_STATUS_VARIANTS },
          charges: { none: {} },
          classSessionId: null,
          coveredByChargeId: null,
          OR: [{ servedAt: window }, { servedAt: null, scheduledAt: window }],
        },
        select: {
          id: true,
          customerId: true,
          serviceId: true,
          priceCOP: true,
          servedAt: true,
          scheduledAt: true,
          customer: { select: { name: true } },
          service: { select: { name: true, priceCOP: true } },
        },
        orderBy: { scheduledAt: 'desc' },
      }),
    ]);

    const today = calendarDayCO(new Date());

    const byMethod = new Map<string, { amountCOP: number; count: number }>();
    let incomeCOP = 0;
    for (const p of payments) {
      incomeCOP += p.amountCOP;
      const entry = byMethod.get(p.method) ?? { amountCOP: 0, count: 0 };
      entry.amountCOP += p.amountCOP;
      entry.count += 1;
      byMethod.set(p.method, entry);
    }

    // Lo contratado en el período, por servicio. Sin servicio, agrupa por el
    // concepto escrito: "Producto: proteína" no tiene servicio y es una venta.
    const byService = new Map<
      string,
      { name: string; count: number; chargedCOP: number; paidCOP: number }
    >();
    let chargedCOP = 0;
    for (const row of charges) {
      const dto = this.toDto(row, today);
      chargedCOP += dto.totalCOP;
      const key = row.serviceId ?? `concept:${row.concept.toLowerCase()}`;
      const entry = byService.get(key) ?? {
        name: row.service?.name ?? row.concept,
        count: 0,
        chargedCOP: 0,
        paidCOP: 0,
      };
      entry.count += 1;
      entry.chargedCOP += dto.totalCOP;
      entry.paidCOP += dto.paidCOP;
      byService.set(key, entry);
    }

    const unchargedRows = uncharged.map((a) => ({
      appointmentId: a.id,
      customerId: a.customerId,
      customerName: a.customer.name,
      serviceId: a.serviceId,
      serviceName: a.service.name,
      priceCOP: a.priceCOP ?? a.service.priceCOP,
      servedAt: (a.servedAt ?? a.scheduledAt).toISOString(),
    }));
    for (const row of unchargedRows) {
      const entry = byService.get(row.serviceId) ?? {
        name: row.serviceName,
        count: 0,
        chargedCOP: 0,
        paidCOP: 0,
      };
      entry.count += 1;
      entry.chargedCOP += row.priceCOP;
      entry.paidCOP += row.priceCOP;
      byService.set(row.serviceId, entry);
    }
    const unchargedCOP = unchargedRows.reduce((acc, r) => acc + r.priceCOP, 0);

    const receivables = open
      .map((row) => this.toDto(row, today))
      .filter((c) => c.balanceCOP > 0);
    const sumBalance = (status: BarberChargeStatus[]) =>
      receivables
        .filter((c) => status.includes(c.status))
        .reduce((acc, c) => acc + c.balanceCOP, 0);

    return {
      /** Lo que entró: pagos + citas completadas sin cobro. Igual al dashboard. */
      incomeCOP: incomeCOP + unchargedCOP,
      paymentsIncomeCOP: incomeCOP,
      paymentsCount: payments.length,
      uncharged: {
        count: unchargedRows.length,
        totalCOP: unchargedCOP,
        appointments: unchargedRows,
      },
      chargesCount: charges.length,
      chargedCOP,
      byMethod: [...byMethod.entries()]
        .map(([method, v]) => ({ method, ...v }))
        .sort((a, b) => b.amountCOP - a.amountCOP),
      byService: [...byService.entries()]
        .map(([key, v]) => ({ key, ...v }))
        .sort((a, b) => b.chargedCOP - a.chargedCOP || b.count - a.count),
      receivable: {
        totalCOP: sumBalance(['PENDING', 'IN_TERM', 'DUE_TODAY', 'OVERDUE']),
        inTermCOP: sumBalance(['IN_TERM']),
        dueTodayCOP: sumBalance(['DUE_TODAY']),
        overdueCOP: sumBalance(['OVERDUE']),
        pendingCOP: sumBalance(['PENDING']),
        chargesCount: receivables.length,
        customersCount: new Set(receivables.map((c) => c.customerId ?? c.id))
          .size,
      },
    };
  }

  async create(ctx: TenantContext, dto: CreateBarberChargeDto) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);

    let customerId = dto.customerId ?? null;
    let serviceId = dto.serviceId ?? null;
    let concept = dto.concept?.trim() ?? '';
    let totalCOP = dto.totalCOP;
    let chargedAt = dto.chargedAt ? this.resolveInstant(dto.chargedAt) : null;
    let startsOn = dto.startsOn ?? null;
    let endsOn = dto.endsOn ?? null;
    let sessionsTotal = dto.sessionsTotal ?? null;

    if (dto.appointmentId) {
      await this.tenantHelper.assertScopedRecord(
        'barberAppointment',
        ctx,
        dto.appointmentId,
        'Appointment',
      );
      const appt = await this.prisma.barberAppointment.findUniqueOrThrow({
        where: { id: dto.appointmentId },
        include: { service: { select: { name: true, priceCOP: true } } },
      });
      customerId = customerId ?? appt.customerId;
      serviceId = serviceId ?? appt.serviceId;
      concept = concept || appt.service.name;
      totalCOP = totalCOP ?? appt.priceCOP ?? appt.service.priceCOP;
      chargedAt = chargedAt ?? appt.servedAt ?? appt.scheduledAt;
    }
    if (serviceId && !dto.appointmentId) {
      await this.tenantHelper.assertScopedRecord(
        'barberService',
        ctx,
        serviceId,
        'Service',
      );
      const service = await this.prisma.barberService.findUniqueOrThrow({
        where: { id: serviceId },
        select: {
          name: true,
          priceCOP: true,
          validityDays: true,
          sessionsIncluded: true,
        },
      });
      concept = concept || service.name;
      totalCOP = totalCOP ?? service.priceCOP;
      // Un plan o paquete trae su vigencia y sus sesiones: si no las mandan,
      // salen del servicio. Mandarlas (aunque sea null) manda sobre él.
      if (dto.endsOn === undefined && service.validityDays) {
        endsOn = addDays(
          startsOn ?? calendarDayCO(new Date()),
          service.validityDays - 1,
        );
        startsOn = startsOn ?? calendarDayCO(new Date());
      }
      if (dto.sessionsTotal === undefined) {
        sessionsTotal = service.sessionsIncluded;
      }
    }
    if (customerId) {
      await this.tenantHelper.assertScopedRecord(
        'barberCustomer',
        ctx,
        customerId,
        'Customer',
      );
    }
    if (concept.length < 2) {
      throw new BadRequestException('Escribe qué se está cobrando');
    }
    if (totalCOP === undefined) {
      throw new BadRequestException('Falta el valor del cobro');
    }
    this.assertDayOrder(startsOn ?? undefined, endsOn ?? undefined);
    if (dto.payment && dto.payment.amountCOP > totalCOP) {
      throw new BadRequestException(
        'El pago no puede ser mayor que el valor del cobro',
      );
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // Una cita se cobra una vez. Para corregir, se anula el cobro y se hace
      // otro: así el histórico dice lo que pasó. Va dentro de la transacción
      // para que dos clics seguidos no creen dos cobros.
      if (dto.appointmentId) {
        const existing = await tx.barberCharge.findFirst({
          where: { appointmentId: dto.appointmentId, voidedAt: null },
          select: { id: true },
        });
        if (existing) {
          throw new ConflictException({
            code: 'APPOINTMENT_ALREADY_CHARGED',
            message: 'Esta cita ya tiene un cobro. Abónale a ese cobro.',
          });
        }
      }

      const charge = await tx.barberCharge.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          customerId,
          appointmentId: dto.appointmentId ?? null,
          serviceId,
          concept,
          totalCOP: totalCOP,
          ...(chargedAt ? { chargedAt } : {}),
          startsOn: startsOn ? dateOf(startsOn) : null,
          endsOn: endsOn ? dateOf(endsOn) : null,
          dueOn: dto.dueOn ? dateOf(dto.dueOn) : null,
          sessionsTotal,
          note: dto.note ?? null,
          userId: ctx.userId,
          userName: ctx.name,
        },
      });
      if (dto.payment) {
        await this.insertPayment(tx, ctx, charge.id, dto.payment);
      }
      return charge;
    });

    return this.findOne(ctx, created.id);
  }

  async update(ctx: TenantContext, id: string, dto: UpdateBarberChargeDto) {
    const current = await this.findScoped(ctx, id);
    if (current.voidedAt) {
      throw new BadRequestException('El cobro está anulado');
    }
    if (dto.totalCOP !== undefined) {
      const paid = this.paidOf(current);
      if (dto.totalCOP < paid) {
        throw new BadRequestException(
          'El valor no puede quedar por debajo de lo que ya pagó',
        );
      }
    }
    const startsOn =
      dto.startsOn === undefined ? dayOf(current.startsOn) : dto.startsOn;
    const endsOn =
      dto.endsOn === undefined ? dayOf(current.endsOn) : dto.endsOn;
    this.assertDayOrder(startsOn ?? undefined, endsOn ?? undefined);

    await this.prisma.barberCharge.update({
      where: { id },
      data: {
        totalCOP: dto.totalCOP,
        note: dto.note,
        ...(dto.startsOn !== undefined
          ? { startsOn: dto.startsOn ? dateOf(dto.startsOn) : null }
          : {}),
        ...(dto.endsOn !== undefined
          ? { endsOn: dto.endsOn ? dateOf(dto.endsOn) : null }
          : {}),
        ...(dto.dueOn !== undefined
          ? { dueOn: dto.dueOn ? dateOf(dto.dueOn) : null }
          : {}),
        ...(dto.sessionsTotal !== undefined
          ? { sessionsTotal: dto.sessionsTotal }
          : {}),
      },
    });
    return this.findOne(ctx, id);
  }

  /**
   * Renueva un plan: un cobro NUEVO por el período siguiente. El viejo queda
   * como estaba, con sus pagos: cada mes es su propio cobro y su propia deuda.
   *
   * Si está al día, el período nuevo arranca el día siguiente al fin del
   * anterior (no se le pierden días por renovar antes). Si ya venció, arranca
   * hoy: no se le cobran los días que no vino.
   */
  async renew(ctx: TenantContext, id: string, dto: RenewBarberChargeDto) {
    const current = await this.findScoped(ctx, id);
    if (!current.endsOn) {
      throw new BadRequestException('Este cobro no tiene vigencia que renovar');
    }
    const service = current.serviceId
      ? await this.prisma.barberService.findUnique({
          where: { id: current.serviceId },
          select: {
            name: true,
            priceCOP: true,
            validityDays: true,
            sessionsIncluded: true,
          },
        })
      : null;

    const today = calendarDayCO(new Date());
    const prevEnd = dayOf(current.endsOn)!;
    const startsOn = prevEnd >= today ? addDays(prevEnd, 1) : today;
    // El largo del período: el del plan; si no hay plan, el del cobro anterior
    // sin los días que se congeló.
    const length =
      service?.validityDays ??
      (current.startsOn
        ? daysBetween(dayOf(current.startsOn)!, prevEnd) +
          1 -
          current.frozenDays
        : 30);

    return this.create(ctx, {
      customerId: current.customerId ?? undefined,
      serviceId: current.serviceId ?? undefined,
      concept: service?.name ?? current.concept,
      totalCOP: dto.totalCOP ?? service?.priceCOP ?? current.totalCOP,
      startsOn,
      endsOn: addDays(startsOn, Math.max(1, length) - 1),
      sessionsTotal: service?.sessionsIncluded ?? current.sessionsTotal,
      dueOn: dto.dueOn,
      note: dto.note,
      payment: dto.payment,
    });
  }

  /**
   * Congela un plan N días (viaje, lesión): la vigencia se corre esos días. Se
   * suman a `frozenDays` para que se vea por qué el plan dura más, y el motivo
   * queda en la nota.
   */
  async freeze(ctx: TenantContext, id: string, dto: FreezeBarberChargeDto) {
    const current = await this.findScoped(ctx, id);
    if (current.voidedAt) {
      throw new BadRequestException('El cobro está anulado');
    }
    if (!current.endsOn) {
      throw new BadRequestException(
        'Este cobro no tiene vigencia que congelar',
      );
    }
    const line = `Congelado ${dto.days} día(s) el ${calendarDayCO(new Date())}: ${dto.reason}`;
    await this.prisma.barberCharge.update({
      where: { id },
      data: {
        endsOn: dateOf(addDays(dayOf(current.endsOn)!, dto.days)),
        frozenDays: { increment: dto.days },
        note: current.note ? `${current.note}\n${line}` : line,
      },
    });
    return this.findOne(ctx, id);
  }

  /**
   * Marca que una cita la cubre un plan o paquete: no se cobra aparte y, si el
   * paquete cuenta sesiones, gasta una. La cita tiene que caer dentro de la
   * vigencia y al paquete le tienen que quedar sesiones.
   */
  async cover(ctx: TenantContext, id: string, appointmentId: string) {
    await this.findScoped(ctx, id);
    await this.tenantHelper.assertScopedRecord(
      'barberAppointment',
      ctx,
      appointmentId,
      'Appointment',
    );
    await this.prisma.$transaction(async (tx) => {
      const appt = await tx.barberAppointment.findUniqueOrThrow({
        where: { id: appointmentId },
        select: {
          customerId: true,
          scheduledAt: true,
          servedAt: true,
          charges: { where: { voidedAt: null }, select: { id: true } },
        },
      });
      if (appt.charges.length > 0) {
        throw new ConflictException({
          code: 'APPOINTMENT_ALREADY_CHARGED',
          message: 'Esta cita ya tiene un cobro propio.',
        });
      }
      const day = calendarDayCO(appt.servedAt ?? appt.scheduledAt);
      const charge = await tx.barberCharge.findUniqueOrThrow({
        where: { id },
        include: CHARGE_INCLUDE,
      });
      const problem = this.coverageProblem(charge, appt.customerId, day);
      if (problem) throw new BadRequestException(problem);
      await tx.barberAppointment.update({
        where: { id: appointmentId },
        data: { coveredByChargeId: id },
      });
    });
    return this.findOne(ctx, id);
  }

  async uncover(ctx: TenantContext, appointmentId: string) {
    await this.tenantHelper.assertScopedRecord(
      'barberAppointment',
      ctx,
      appointmentId,
      'Appointment',
    );
    await this.prisma.barberAppointment.update({
      where: { id: appointmentId },
      data: { coveredByChargeId: null },
    });
    return { ok: true };
  }

  /**
   * El plan o paquete que cubre a un cliente un día dado, o null. Prefiere el
   * plan sin límite de sesiones (no gasta nada) y, entre paquetes, el que vence
   * primero, para que no se le venzan sesiones sin usar.
   */
  async findCoveringCharge(
    db: Prisma.TransactionClient,
    ctx: TenantContext,
    customerId: string,
    day: string,
  ) {
    const candidates = await db.barberCharge.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        customerId,
        voidedAt: null,
        OR: [{ endsOn: { not: null } }, { sessionsTotal: { not: null } }],
      },
      include: CHARGE_INCLUDE,
    });
    const usable = candidates.filter(
      (c) => this.coverageProblem(c, customerId, day) === null,
    );
    usable.sort((a, b) => {
      if ((a.sessionsTotal === null) !== (b.sessionsTotal === null)) {
        return a.sessionsTotal === null ? -1 : 1;
      }
      return (dayOf(a.endsOn) ?? '9999').localeCompare(
        dayOf(b.endsOn) ?? '9999',
      );
    });
    return usable[0] ?? null;
  }

  /**
   * Cómo va la membresía de cada cliente: su plan o paquete vigente (o el
   * último que tuvo) y lo que debe.
   */
  async memberships(ctx: TenantContext, query: ListBarberMembershipsQueryDto) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    const rows = await this.prisma.barberCharge.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        voidedAt: null,
        customerId: query.customerId ?? { not: null },
        OR: [{ endsOn: { not: null } }, { sessionsTotal: { not: null } }],
      },
      include: CHARGE_INCLUDE,
    });

    const today = calendarDayCO(new Date());
    const warnDays = query.days ?? 5;
    const byCustomer = new Map<string, ChargeRow[]>();
    for (const row of rows) {
      const list = byCustomer.get(row.customerId!) ?? [];
      list.push(row);
      byCustomer.set(row.customerId!, list);
    }

    const result = [...byCustomer.values()].map((charges) => {
      // La que manda: la vigente hoy que vence más tarde; si no hay, la
      // próxima en arrancar; si tampoco, la que venció más recientemente.
      const dtos = charges.map((c) => this.toDto(c, today));
      const current =
        dtos
          .filter(
            (c) =>
              c.membershipState === 'ACTIVE' ||
              c.membershipState === 'EXPIRING' ||
              c.membershipState === 'NO_SESSIONS',
          )
          .sort((a, b) =>
            (b.endsOn ?? '9999').localeCompare(a.endsOn ?? '9999'),
          )[0] ??
        dtos
          .filter((c) => c.membershipState === 'UPCOMING')
          .sort((a, b) =>
            (a.startsOn ?? '').localeCompare(b.startsOn ?? ''),
          )[0] ??
        dtos.sort((a, b) => (b.endsOn ?? '').localeCompare(a.endsOn ?? ''))[0];
      let state: BarberMembershipState = current.membershipState!;
      if (
        state === 'ACTIVE' &&
        current.endsOn &&
        daysBetween(today, current.endsOn) < warnDays
      ) {
        state = 'EXPIRING';
      }
      return {
        customerId: current.customerId!,
        customerName: current.customerName,
        customerPhone: current.customerPhone,
        state,
        daysLeft: current.endsOn ? daysBetween(today, current.endsOn) : null,
        balanceCOP: dtos.reduce((acc, c) => acc + c.balanceCOP, 0),
        current,
      };
    });

    const filtered =
      query.state && query.state !== 'ALL'
        ? result.filter((m) => m.state === query.state)
        : result;
    return filtered.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
  }

  async addPayment(ctx: TenantContext, id: string, dto: BarberPaymentInputDto) {
    await this.findScoped(ctx, id);
    await this.prisma.$transaction(async (tx) => {
      // El saldo se lee DENTRO de la transacción: dos abonos al tiempo no
      // pueden pasarse del total.
      const charge = await tx.barberCharge.findUniqueOrThrow({
        where: { id },
        include: { payments: true },
      });
      if (charge.voidedAt) {
        throw new BadRequestException('El cobro está anulado');
      }
      const balance = charge.totalCOP - this.paidOf(charge);
      if (dto.amountCOP > balance) {
        throw new BadRequestException(
          `El pago es mayor que el saldo pendiente (${balance})`,
        );
      }
      await this.insertPayment(tx, ctx, id, dto);
    });
    return this.findOne(ctx, id);
  }

  async voidCharge(ctx: TenantContext, id: string, reason: string) {
    const current = await this.findScoped(ctx, id);
    if (current.voidedAt) {
      throw new BadRequestException('El cobro ya está anulado');
    }
    await this.prisma.barberCharge.update({
      where: { id },
      data: { voidedAt: new Date(), voidedReason: reason, voidedBy: ctx.name },
    });
    return this.findOne(ctx, id);
  }

  async voidPayment(
    ctx: TenantContext,
    id: string,
    paymentId: string,
    reason: string,
  ) {
    await this.findScoped(ctx, id);
    const payment = await this.prisma.barberPayment.findFirst({
      where: { id: paymentId, chargeId: id },
      select: { voidedAt: true },
    });
    if (!payment) throw new NotFoundException(`Payment ${paymentId} not found`);
    if (payment.voidedAt) {
      throw new BadRequestException('El pago ya está anulado');
    }
    await this.prisma.barberPayment.update({
      where: { id: paymentId },
      data: { voidedAt: new Date(), voidedReason: reason, voidedBy: ctx.name },
    });
    return this.findOne(ctx, id);
  }

  async findOne(ctx: TenantContext, id: string) {
    const row = await this.prisma.barberCharge.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: CHARGE_INCLUDE,
    });
    if (!row) throw new NotFoundException(`Charge ${id} not found`);
    return this.toDto(row, calendarDayCO(new Date()));
  }

  // ─── Internos ──────────────────────────────────────────────────────────────

  private toDto(row: ChargeRow, today: string) {
    const paidCOP = this.paidOf(row);
    const balanceCOP = row.voidedAt ? 0 : Math.max(0, row.totalCOP - paidCOP);
    const dueOn = dayOf(row.dueOn);
    const endsOn = dayOf(row.endsOn);

    const startsOn = dayOf(row.startsOn);
    const sessionsUsed = row._count.coveredAppointments;
    const sessionsLeft =
      row.sessionsTotal === null
        ? null
        : Math.max(0, row.sessionsTotal - sessionsUsed);
    const isMembership = row.endsOn !== null || row.sessionsTotal !== null;

    let membershipState: BarberMembershipState | null = null;
    if (isMembership && !row.voidedAt) {
      if (startsOn && startsOn > today) membershipState = 'UPCOMING';
      else if (endsOn && endsOn < today) membershipState = 'EXPIRED';
      else if (sessionsLeft === 0) membershipState = 'NO_SESSIONS';
      else membershipState = 'ACTIVE';
    }

    let status: BarberChargeStatus;
    if (row.voidedAt) status = 'VOIDED';
    else if (balanceCOP === 0) status = 'PAID';
    else if (!dueOn) status = 'PENDING';
    else if (dueOn > today) status = 'IN_TERM';
    else if (dueOn === today) status = 'DUE_TODAY';
    else status = 'OVERDUE';

    return {
      id: row.id,
      customerId: row.customerId,
      customerName: row.customer?.name ?? null,
      customerPhone: row.customer?.phone ?? null,
      appointmentId: row.appointmentId,
      serviceId: row.serviceId,
      serviceName: row.service?.name ?? null,
      color: row.service?.color ?? null,
      concept: row.concept,
      totalCOP: row.totalCOP,
      paidCOP,
      balanceCOP,
      status,
      chargedAt: row.chargedAt.toISOString(),
      startsOn,
      endsOn,
      dueOn,
      /** Lo contratado sigue vigente hoy. null = no tiene fecha de fin. */
      isActive: endsOn ? endsOn >= today : null,
      kind: row.service?.kind ?? null,
      isMembership,
      // Ancho a propósito: `memberships()` lo sube a EXPIRING con la ventana.
      membershipState: membershipState as BarberMembershipState | null,
      sessionsTotal: row.sessionsTotal,
      sessionsUsed,
      sessionsLeft,
      frozenDays: row.frozenDays,
      note: row.note,
      userName: row.userName,
      voidedAt: row.voidedAt?.toISOString() ?? null,
      voidedReason: row.voidedReason,
      payments: row.payments.map((p) => ({
        id: p.id,
        amountCOP: p.amountCOP,
        method: p.method,
        paidAt: p.paidAt.toISOString(),
        note: p.note,
        userName: p.userName,
        voidedAt: p.voidedAt?.toISOString() ?? null,
        voidedReason: p.voidedReason,
      })),
    };
  }

  /** Por qué este cobro NO cubre esa cita, o null si la cubre. */
  private coverageProblem(
    charge: ChargeRow,
    customerId: string,
    day: string,
  ): string | null {
    if (charge.voidedAt) return 'El plan está anulado';
    if (charge.customerId !== customerId) {
      return 'El plan es de otro cliente';
    }
    if (charge.endsOn === null && charge.sessionsTotal === null) {
      return 'Este cobro no es un plan ni un paquete';
    }
    const startsOn = dayOf(charge.startsOn);
    const endsOn = dayOf(charge.endsOn);
    if (startsOn && day < startsOn) return 'El plan todavía no ha empezado';
    if (endsOn && day > endsOn) return 'El plan ya venció';
    if (
      charge.sessionsTotal !== null &&
      charge._count.coveredAppointments >= charge.sessionsTotal
    ) {
      return 'El paquete ya no tiene sesiones';
    }
    return null;
  }

  private paidOf(row: {
    payments: { amountCOP: number; voidedAt: Date | null }[];
  }) {
    return row.payments
      .filter((p) => !p.voidedAt)
      .reduce((acc, p) => acc + p.amountCOP, 0);
  }

  private insertPayment(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    chargeId: string,
    dto: BarberPaymentInputDto,
  ) {
    return tx.barberPayment.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        chargeId,
        amountCOP: dto.amountCOP,
        method: dto.method,
        paidAt: dto.paidAt ? this.resolveInstant(dto.paidAt) : new Date(),
        note: dto.note ?? null,
        userId: ctx.userId,
        userName: ctx.name,
      },
    });
  }

  private async findScoped(ctx: TenantContext, id: string) {
    const row = await this.prisma.barberCharge.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: { payments: true },
    });
    if (!row) throw new NotFoundException(`Charge ${id} not found`);
    return row;
  }

  private window(from?: string, to?: string): Prisma.DateTimeFilter {
    return {
      ...(from ? { gte: dayStartCO(from) } : {}),
      ...(to ? { lte: dayEndCO(to) } : {}),
    };
  }

  private assertDayOrder(startsOn?: string, endsOn?: string) {
    if (startsOn && endsOn && endsOn < startsOn) {
      throw new BadRequestException(
        'La fecha de fin no puede ser antes de la de inicio',
      );
    }
  }

  /**
   * Una fecha sin hora se ancla a la hora actual de Colombia, no a
   * medianoche: así cae dentro del día que se quiso y no en el borde. Misma
   * regla que la fecha de servicio de las citas.
   */
  private resolveInstant(value: string): Date {
    const now = new Date();
    const parsed = DAY_RE.test(value)
      ? new Date(`${value}T${clockTimeCO(now)}${CO_UTC_OFFSET}`)
      : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Fecha inválida: ${value}`);
    }
    if (calendarDayCO(parsed) > calendarDayCO(now)) {
      throw new BadRequestException(
        'No se puede registrar un pago en el futuro',
      );
    }
    return parsed;
  }
}
