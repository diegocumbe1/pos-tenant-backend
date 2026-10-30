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
  formatCOP,
  formatDateCO,
} from '../../../common/date.util';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import { COMPLETED_STATUS_VARIANTS } from '../../shared/appointment-status';
import { addMonthsDay, planCycle, usedInCycle, type FreezeRange } from '../../shared/plan-cycle';
import {
  BarberPaymentInputDto,
  CreateBarberChargeDto,
  FreezeBarberChargeDto,
  ListBarberChargesQueryDto,
  ListBarberMembershipsQueryDto,
  RenewBarberChargeDto,
  SettleBarberSessionsDto,
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
      sessionsPerMonth: true,
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
  // Para el cupo por mes de plan: en qué días se usó cada sesión.
  coveredAppointments: {
    where: { status: { notIn: NOT_CONSUMED_STATUSES } },
    select: { id: true, scheduledAt: true, servedAt: true, quotaMode: true },
  },
  freezes: { orderBy: { startsOn: 'asc' } },
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
    let sessionsPerMonth = dto.sessionsPerMonth ?? null;

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
          sessionsPerMonth: true,
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
      if (dto.sessionsPerMonth === undefined) {
        sessionsPerMonth = service.sessionsPerMonth;
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
    const payments = [
      ...(dto.payment ? [dto.payment] : []),
      ...(dto.payments ?? []),
    ];
    const paidCOP = payments.reduce((sum, p) => sum + p.amountCOP, 0);
    if (paidCOP > totalCOP) {
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
          discountCOP: dto.discountCOP ?? 0,
          ...(chargedAt ? { chargedAt } : {}),
          startsOn: startsOn ? dateOf(startsOn) : null,
          endsOn: endsOn ? dateOf(endsOn) : null,
          dueOn: dto.dueOn ? dateOf(dto.dueOn) : null,
          sessionsTotal,
          sessionsPerMonth,
          note: dto.note ?? null,
          userId: ctx.userId,
          userName: ctx.name,
        },
      });
      for (const payment of payments) {
        await this.insertPayment(tx, ctx, charge.id, payment);
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
        ...(dto.sessionsPerMonth !== undefined
          ? { sessionsPerMonth: dto.sessionsPerMonth }
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
      ...(service ? {} : { sessionsPerMonth: current.sessionsPerMonth }),
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
    await this.findScoped(ctx, id);
    const current = await this.prisma.barberCharge.findUniqueOrThrow({
      where: { id },
      include: CHARGE_INCLUDE,
    });
    if (current.voidedAt) {
      throw new BadRequestException('El cobro está anulado');
    }
    if (!current.endsOn) {
      throw new BadRequestException('Este cobro no tiene vigencia que congelar');
    }
    const today = calendarDayCO(new Date());
    const planEnd = dayOf(current.endsOn)!;
    // Congelar un plan vencido lo "revive" y cubre hacia atrás días que no se
    // pagaron. Si ya venció, se renueva.
    if (planEnd < today) {
      throw new BadRequestException('El plan ya venció: renuévalo en vez de congelarlo');
    }

    const start = dto.startsOn ?? today;
    if (start > planEnd) {
      throw new BadRequestException('La congelación tiene que empezar antes de que venza el plan');
    }
    const startsOn = dayOf(current.startsOn);
    if (startsOn && start < startsOn) {
      throw new BadRequestException('La congelación no puede empezar antes que el plan');
    }
    if (!dto.days && !dto.untilOn) {
      throw new BadRequestException('Indica cuántos días o hasta qué fecha');
    }
    const end = dto.untilOn ?? addDays(start, dto.days! - 1);
    if (end < start) throw new BadRequestException('La fecha final es antes de la inicial');
    const days = daysBetween(start, end) + 1;
    if (days > 365) throw new BadRequestException('Máximo 365 días');

    if (this.freezesOf(current).some((f) => f.start <= end && start <= f.end)) {
      throw new ConflictException({
        code: 'FREEZE_OVERLAP',
        message: 'Ya hay una congelación en esas fechas',
      });
    }
    // Lo que ya vino (o tiene reservado) en esos días no puede quedar sin cubrir.
    const busy = current.coveredAppointments
      .map((a) => calendarDayCO(a.servedAt ?? a.scheduledAt))
      .filter((d) => d >= start && d <= end)
      .sort();
    if (busy.length > 0) {
      throw new ConflictException({
        code: 'FREEZE_HAS_ATTENDANCE',
        message: `Tiene sesiones registradas en esas fechas (${busy.join(', ')}). Congela desde el día siguiente o sácalo de esas clases.`,
      });
    }

    const line = `Congelado del ${start} al ${end} (${days} día(s)): ${dto.reason}`;
    await this.prisma.$transaction([
      this.prisma.barberChargeFreeze.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          chargeId: id,
          startsOn: dateOf(start),
          endsOn: dateOf(end),
          days,
          reason: dto.reason,
          userId: ctx.userId,
          userName: ctx.name,
        },
      }),
      this.prisma.barberCharge.update({
        where: { id },
        data: {
          endsOn: dateOf(addDays(planEnd, days)),
          frozenDays: { increment: days },
          note: current.note ? `${current.note}\n${line}` : line,
        },
      }),
    ]);
    return this.findOne(ctx, id);
  }

  /**
   * Reactivar antes de tiempo: volvió antes de lo previsto. Si la congelación
   * no ha empezado, se borra; si está en curso, termina ayer y se devuelven al
   * plan los días que no usó (la vigencia se acorta lo mismo).
   */
  async unfreeze(ctx: TenantContext, id: string, freezeId: string) {
    const current = await this.findScoped(ctx, id);
    const freeze = await this.prisma.barberChargeFreeze.findFirst({
      where: { id: freezeId, chargeId: id },
    });
    if (!freeze) throw new NotFoundException(`Freeze ${freezeId} not found`);
    const today = calendarDayCO(new Date());
    const start = dayOf(freeze.startsOn)!;
    const end = dayOf(freeze.endsOn)!;
    if (end < today) {
      throw new BadRequestException('Esa congelación ya terminó');
    }
    // Desde hoy vuelve a estar activo: hoy no cuenta como congelado.
    const keepUntil = addDays(today, -1);
    const returned = start > keepUntil ? freeze.days : daysBetween(keepUntil, end);
    const planEnd = dayOf(current.endsOn)!;

    await this.prisma.$transaction([
      start > keepUntil
        ? this.prisma.barberChargeFreeze.delete({ where: { id: freezeId } })
        : this.prisma.barberChargeFreeze.update({
            where: { id: freezeId },
            data: { endsOn: dateOf(keepUntil), days: freeze.days - returned },
          }),
      this.prisma.barberCharge.update({
        where: { id },
        data: {
          endsOn: dateOf(addDays(planEnd, -returned)),
          frozenDays: { decrement: returned },
        },
      }),
    ]);
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
      data: { coveredByChargeId: null, quotaMode: null },
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
   * Lo que la recepción necesita saber ANTES de registrar una asistencia: si su
   * plan la cubre ese día, cuántas sesiones lleva del mes de plan, si el plan
   * venció y cuánto debe. No bloquea nada: con esto se decide si registrar
   * (la sesión de más se cobra aparte) o pausar.
   */
  async attendanceCheck(
    ctx: TenantContext,
    customerId: string,
    day?: string,
    /** La sesión que se va a registrar, si ya existe: no se cuenta contra sí misma. */
    appointmentId?: string,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'barberCustomer',
      ctx,
      customerId,
      'Customer',
    );
    const today = calendarDayCO(new Date());
    const onDay = day ?? today;
    const charges = await this.prisma.barberCharge.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        customerId,
        voidedAt: null,
      },
      include: CHARGE_INCLUDE,
      orderBy: { chargedAt: 'desc' },
    });

    const plans = charges.filter(
      (c) => c.endsOn !== null || c.sessionsTotal !== null,
    );
    const covering =
      plans.find((c) => this.coverageProblem(c, customerId, onDay, appointmentId) === null) ??
      null;
    // Si nada la cubre, el plan del que hablar: el vigente por fechas (está
    // sin cupo o sin sesiones) o, si no, el más reciente.
    const inDates = (c: ChargeRow) =>
      (!c.startsOn || dayOf(c.startsOn)! <= onDay) &&
      (!c.endsOn || dayOf(c.endsOn)! >= onDay);
    const plan = covering ?? plans.find(inDates) ?? plans[0] ?? null;

    const reasons: { code: string; message: string }[] = [];
    if (!plan) {
      reasons.push({ code: 'NO_PLAN', message: 'No tiene plan: la sesión se cobra suelta' });
    } else if (!covering) {
      const startsOn = dayOf(plan.startsOn);
      const endsOn = dayOf(plan.endsOn);
      const frozen = this.frozenOn(plan, onDay);
      if (frozen) {
        reasons.push({
          code: 'PLAN_FROZEN',
          message: `Su plan está congelado hasta el ${formatDateCO(`${frozen.end}T12:00:00${CO_UTC_OFFSET}`)}`,
        });
      } else if (endsOn && onDay > endsOn) {
        reasons.push({ code: 'PLAN_EXPIRED', message: `Su plan venció el ${formatDateCO(`${endsOn}T12:00:00${CO_UTC_OFFSET}`)}` });
      } else if (startsOn && onDay < startsOn) {
        reasons.push({ code: 'PLAN_NOT_STARTED', message: `Su plan arranca el ${formatDateCO(`${startsOn}T12:00:00${CO_UTC_OFFSET}`)}` });
      } else if (
        plan.sessionsTotal !== null &&
        plan._count.coveredAppointments >= plan.sessionsTotal
      ) {
        reasons.push({ code: 'NO_SESSIONS', message: `Ya usó las ${plan.sessionsTotal} sesiones del paquete` });
      } else if (plan.sessionsPerMonth !== null) {
        reasons.push({
          code: 'MONTHLY_LIMIT',
          message: `Ya usó las ${plan.sessionsPerMonth} sesiones de este mes de plan`,
        });
      }
    }

    // Aviso, no problema: con esta sesión se completa el cupo del mes o el paquete.
    if (covering) {
      if (
        covering.sessionsPerMonth !== null &&
        this.cycleUsage(covering, onDay, appointmentId).used === covering.sessionsPerMonth - 1
      ) {
        reasons.push({
          code: 'LAST_SESSION',
          message: `Es su última sesión de este mes de plan (${covering.sessionsPerMonth} de ${covering.sessionsPerMonth})`,
        });
      } else if (
        covering.sessionsTotal !== null &&
        covering.sessionsTotal - covering._count.coveredAppointments === 1
      ) {
        reasons.push({
          code: 'LAST_SESSION',
          message: `Es la última sesión del paquete (${covering.sessionsTotal} de ${covering.sessionsTotal})`,
        });
      }
    }

    const dtos = charges.map((c) => this.toDto(c, today));
    const open = dtos.filter((c) => c.balanceCOP > 0);
    const balanceCOP = open.reduce((acc, c) => acc + c.balanceCOP, 0);
    const overdueCOP = open
      .filter((c) => c.status === 'OVERDUE' || c.status === 'DUE_TODAY')
      .reduce((acc, c) => acc + c.balanceCOP, 0);
    if (overdueCOP > 0) {
      reasons.push({ code: 'DEBT_OVERDUE', message: `Tiene ${formatCOP(overdueCOP)} vencido por pagar` });
    } else if (balanceCOP > 0) {
      reasons.push({ code: 'DEBT_PENDING', message: `Debe ${formatCOP(balanceCOP)}` });
    }

    const planDto = plan ? this.toDto(plan, today) : null;
    let nextCycle: { start: string; end: string; used: number; left: number; available: boolean } | null = null;
    if (plan && plan.sessionsPerMonth !== null) {
      const start = addDays(planCycle(dayOf(plan.startsOn), onDay, this.freezesOf(plan)).end, 1);
      const usage = this.cycleUsage(plan, start);
      const endsOn = dayOf(plan.endsOn);
      const left = Math.max(0, plan.sessionsPerMonth - usage.used);
      nextCycle = {
        start: usage.start,
        end: usage.end,
        used: usage.used,
        left,
        available: (!endsOn || start <= endsOn) && left > 0,
      };
    }
    const cycle =
      plan && plan.sessionsPerMonth !== null
        ? this.cycleUsage(plan, onDay, appointmentId)
        : null;
    return {
      customerId,
      day: onDay,
      covers: covering !== null,
      plan: planDto
        ? {
            chargeId: planDto.id,
            concept: planDto.concept,
            serviceId: planDto.serviceId,
            startsOn: planDto.startsOn,
            endsOn: planDto.endsOn,
            sessionsTotal: planDto.sessionsTotal,
            sessionsLeft: planDto.sessionsLeft,
            sessionsPerMonth: planDto.sessionsPerMonth,
            cycle: cycle
              ? {
                  start: cycle.start,
                  end: cycle.end,
                  used: cycle.used,
                  left: Math.max(0, plan!.sessionsPerMonth! - cycle.used),
                }
              : null,
            perSessionCOP: planDto.perSessionCOP,
            // Para "descontar del próximo mes": si el plan llega y queda cupo.
            nextCycle: nextCycle,
          }
        : null,
      debt: { balanceCOP, overdueCOP },
      reasons,
    };
  }

  /**
   * Estado de cuenta por meses de plan, desde el primer plan hasta hoy. Arrancó
   * en abril y estamos en octubre: mes por mes, qué se cobró y si se pagó,
   * cuántas sesiones hizo y cuáles quedaron sin cobrar.
   *
   *   PAID       → lo cubre un cobro pagado.
   *   OWED       → lo cubre un cobro con saldo pendiente.
   *   NOT_CHARGED→ vino y ningún cobro cubre ese mes: se le debe cobrar.
   *   INACTIVE   → no vino y no hay cobro: no se cuenta como deuda.
   */
  async account(ctx: TenantContext, customerId: string) {
    await this.tenantHelper.assertScopedRecord('barberCustomer', ctx, customerId, 'Customer');
    const today = calendarDayCO(new Date());
    const rows = await this.prisma.barberCharge.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        customerId,
        voidedAt: null,
        OR: [
          { endsOn: { not: null } },
          { sessionsTotal: { not: null } },
          { sessionsPerMonth: { not: null } },
        ],
      },
      include: CHARGE_INCLUDE,
      orderBy: { chargedAt: 'asc' },
    });
    const plans = rows.map((r) => ({ row: r, dto: this.toDto(r, today) }));
    const firstStart = plans
      .map((p) => p.dto.startsOn ?? calendarDayCO(p.row.chargedAt))
      .sort()[0];
    if (!firstStart) {
      return { customerId, anchor: null, months: [], totals: { monthsOwed: 0, owedCOP: 0 }, plan: null };
    }

    // El plan de referencia (precio del mes, cupo, valor por sesión): el último.
    const latest = plans[plans.length - 1];
    const planPriceCOP = latest.row.service?.priceCOP ?? latest.row.totalCOP;
    const sessionsPerMonth =
      latest.row.sessionsPerMonth ?? latest.row.service?.sessionsPerMonth ?? null;
    const perSessionCOP = latest.dto.perSessionCOP;

    const visits = await this.prisma.barberAppointment.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        customerId,
        status: { in: COMPLETED_STATUS_VARIANTS },
        OR: [
          { servedAt: { gte: dayStartCO(firstStart) } },
          { servedAt: null, scheduledAt: { gte: dayStartCO(firstStart) } },
        ],
      },
      select: {
        id: true,
        servedAt: true,
        scheduledAt: true,
        coveredByChargeId: true,
        charges: { where: { voidedAt: null }, select: { id: true } },
      },
    });
    const visitDays = visits.map((v) => ({
      id: v.id,
      day: calendarDayCO(v.servedAt ?? v.scheduledAt),
      settled: !!v.coveredByChargeId || v.charges.length > 0,
    }));

    const months: {
      start: string;
      end: string;
      isCurrent: boolean;
      sessions: number;
      sessionsPerMonth: number | null;
      status: 'PAID' | 'OWED' | 'NOT_CHARGED' | 'INACTIVE';
      charges: { id: string; concept: string; totalCOP: number; paidCOP: number; balanceCOP: number; status: string }[];
      /** Visitas de ese mes que nada cubrió ni cobró (sin plan o pasadas del cupo). */
      unsettledAppointmentIds: string[];
    }[] = [];
    for (let k = 0; addMonthsDay(firstStart, k) <= today; k++) {
      const start = addMonthsDay(firstStart, k);
      const end = addDays(addMonthsDay(firstStart, k + 1), -1);
      const inMonth = visitDays.filter((v) => v.day >= start && v.day <= end);
      const covering = plans.filter((p) => {
        const from = p.dto.startsOn ?? calendarDayCO(p.row.chargedAt);
        const to = p.dto.endsOn ?? from;
        return from <= end && to >= start;
      });
      // Sin plan que lo cubra: si cada visita se cobró suelta, está al día; si
      // quedó alguna sin cobrar, falta cobrar ese mes.
      const status = covering.length
        ? covering.some((p) => p.dto.balanceCOP > 0)
          ? 'OWED'
          : 'PAID'
        : inMonth.some((v) => !v.settled)
          ? 'NOT_CHARGED'
          : inMonth.length > 0
            ? 'PAID'
            : 'INACTIVE';
      months.push({
        start,
        end,
        isCurrent: start <= today && today <= end,
        sessions: inMonth.length,
        sessionsPerMonth,
        status,
        charges: covering.map((p) => ({
          id: p.dto.id,
          concept: p.dto.concept,
          totalCOP: p.dto.totalCOP,
          paidCOP: p.dto.paidCOP,
          balanceCOP: p.dto.balanceCOP,
          status: p.dto.status,
        })),
        unsettledAppointmentIds: inMonth.filter((v) => !v.settled).map((v) => v.id),
      });
    }

    // Lo que debe: saldos de los cobros (una vez cada uno, aunque cubran
    // varios meses) + un mes de plan por cada mes que vino sin cobro.
    const owedCharges = new Map<string, number>();
    for (const m of months) for (const c of m.charges) if (c.balanceCOP > 0) owedCharges.set(c.id, c.balanceCOP);
    const notCharged = months.filter((m) => m.status === 'NOT_CHARGED');
    return {
      customerId,
      anchor: firstStart,
      plan: {
        serviceId: latest.row.serviceId,
        concept: latest.row.service?.name ?? latest.row.concept,
        priceCOP: planPriceCOP,
        sessionsPerMonth,
        perSessionCOP,
      },
      months: months.reverse(),
      totals: {
        monthsOwed: months.filter((m) => m.status === 'OWED' || m.status === 'NOT_CHARGED').length,
        owedCOP:
          [...owedCharges.values()].reduce((a, b) => a + b, 0) +
          notCharged.length * planPriceCOP,
      },
    };
  }

  /**
   * Cobra de una vez visitas que no cubrió ningún plan, y las deja cubiertas
   * por ese cobro (dejan de verse "sin plan" y no se cobran dos veces):
   *   PER_SESSION → visitas × valor por sesión del plan (240.000 / 8 = 30.000).
   *   FULL_PLAN   → el plan completo desde la primera visita; las visitas
   *                 quedan dentro y el resto del mes sigue cubierto.
   */
  async settleSessions(ctx: TenantContext, dto: SettleBarberSessionsDto) {
    await this.tenantHelper.assertScopedRecord('barberService', ctx, dto.serviceId, 'Service');
    const service = await this.prisma.barberService.findUniqueOrThrow({
      where: { id: dto.serviceId },
      select: {
        name: true,
        priceCOP: true,
        validityDays: true,
        sessionsIncluded: true,
        sessionsPerMonth: true,
      },
    });
    const appts = await this.prisma.barberAppointment.findMany({
      where: {
        id: { in: dto.appointmentIds },
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
      },
      select: {
        id: true,
        customerId: true,
        status: true,
        scheduledAt: true,
        servedAt: true,
        coveredByChargeId: true,
        charges: { where: { voidedAt: null }, select: { id: true } },
      },
    });
    if (appts.length !== dto.appointmentIds.length) {
      throw new NotFoundException('Alguna visita no existe');
    }
    for (const a of appts) {
      if (a.customerId !== dto.customerId) {
        throw new BadRequestException('Hay visitas de otro cliente');
      }
      if (NOT_CONSUMED_STATUSES.includes(a.status)) {
        throw new BadRequestException('Solo se cobran visitas en las que vino');
      }
      if (a.coveredByChargeId || a.charges.length > 0) {
        throw new ConflictException({
          code: 'ALREADY_CHARGED',
          message: 'Alguna visita ya está cobrada o cubierta por un plan',
        });
      }
    }

    const days = appts
      .map((a) => calendarDayCO(a.servedAt ?? a.scheduledAt))
      .sort();
    const n = appts.length;
    const perMonth = service.sessionsPerMonth ?? service.sessionsIncluded;
    const perSession = perMonth ? Math.round(service.priceCOP / perMonth) : service.priceCOP;

    const created =
      dto.mode === 'PER_SESSION'
        ? await this.create(ctx, {
            customerId: dto.customerId,
            serviceId: dto.serviceId,
            concept: `${service.name} · ${n} ${n === 1 ? 'sesión' : 'sesiones'}`,
            totalCOP: dto.totalCOP ?? perSession * n,
            // Un "paquete" exacto de esas visitas: no cubre nada más.
            startsOn: days[0],
            endsOn: days[days.length - 1],
            sessionsTotal: n,
            sessionsPerMonth: null,
            dueOn: dto.dueOn,
            note: dto.note,
            payments: dto.payments,
          })
        : await this.create(ctx, {
            customerId: dto.customerId,
            serviceId: dto.serviceId,
            totalCOP: dto.totalCOP ?? service.priceCOP,
            startsOn: days[0],
            ...(service.validityDays
              ? { endsOn: addDays(days[0], service.validityDays - 1) }
              : {}),
            dueOn: dto.dueOn,
            note: dto.note,
            payments: dto.payments,
          });

    await this.prisma.barberAppointment.updateMany({
      where: { id: { in: dto.appointmentIds } },
      // Cubiertas = su plata entró con este cobro, no son venta aparte.
      data: { coveredByChargeId: created.id, priceCOP: 0 },
    });
    return this.findOne(ctx, created.id);
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
    // Mes de plan de hoy (o del último día del plan, si ya venció).
    const cycleDay = endsOn && endsOn < today ? endsOn : today;
    const cycle =
      row.sessionsPerMonth !== null
        ? this.cycleUsage(row, cycleDay)
        : null;

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
      discountCOP: row.discountCOP,
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
      /** Cupo por mes de plan y cómo va el mes de hoy. null = sin cupo. */
      sessionsPerMonth: row.sessionsPerMonth,
      cycle: cycle
        ? {
            start: cycle.start,
            end: cycle.end,
            used: cycle.used,
            left: Math.max(0, row.sessionsPerMonth! - cycle.used),
          }
        : null,
      /** Valor de una sesión: el plan entre su cupo mensual (o el paquete entre sus sesiones). */
      perSessionCOP: this.perSessionCOP(row),
      frozenDays: row.frozenDays,
      /** Congelaciones con fechas. status: por venir, en curso o terminada. */
      freezes: row.freezes.map((f) => {
        const start = dayOf(f.startsOn)!;
        const end = dayOf(f.endsOn)!;
        return {
          id: f.id,
          startsOn: start,
          endsOn: end,
          days: f.days,
          reason: f.reason,
          userName: f.userName,
          status: start > today ? 'UPCOMING' : end < today ? 'DONE' : 'ACTIVE',
        };
      }),
      /** Congelado hoy: no cubre asistencias hasta `endsOn`. */
      frozenNow: (() => {
        const f = row.freezes.find((x) => dayOf(x.startsOn)! <= today && today <= dayOf(x.endsOn)!);
        return f ? { startsOn: dayOf(f.startsOn)!, endsOn: dayOf(f.endsOn)! } : null;
      })(),
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
    excludeAppointmentId?: string,
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
    const frozen = this.frozenOn(charge, day);
    if (frozen) {
      return `El plan está congelado del ${frozen.start} al ${frozen.end}`;
    }
    if (
      charge.sessionsTotal !== null &&
      charge._count.coveredAppointments >= charge.sessionsTotal
    ) {
      return 'El paquete ya no tiene sesiones';
    }
    if (
      charge.sessionsPerMonth !== null &&
      this.cycleUsage(charge, day, excludeAppointmentId).used >= charge.sessionsPerMonth
    ) {
      return `Ya usó las ${charge.sessionsPerMonth} sesiones de este mes de plan`;
    }
    return null;
  }

  /**
   * Sesiones usadas en el mes de plan que contiene `day`. Una cortesía no
   * cuenta; una "del próximo mes" cuenta en el mes siguiente al suyo.
   */
  private cycleUsage(charge: ChargeRow, day: string, excludeAppointmentId?: string) {
    const startsOn = dayOf(charge.startsOn);
    const freezes = this.freezesOf(charge);
    const days = charge.coveredAppointments
      .filter((a) => a.quotaMode !== 'COURTESY' && a.id !== excludeAppointmentId)
      .map((a) => {
        const d = calendarDayCO(a.servedAt ?? a.scheduledAt);
        return a.quotaMode === 'NEXT_CYCLE'
          ? addDays(planCycle(startsOn, d, freezes).end, 1)
          : d;
      });
    return usedInCycle(startsOn, day, days, freezes);
  }

  /** Las congelaciones del plan como rangos de días (inclusive). */
  private freezesOf(charge: ChargeRow): FreezeRange[] {
    return charge.freezes.map((f) => ({ start: dayOf(f.startsOn)!, end: dayOf(f.endsOn)! }));
  }

  /** La congelación que tiene a `day` adentro, si hay. */
  private frozenOn(charge: ChargeRow, day: string): FreezeRange | null {
    return this.freezesOf(charge).find((f) => f.start <= day && day <= f.end) ?? null;
  }

  /**
   * Una sesión pasada del cupo que igual cubre el plan: se descuenta del mes
   * de plan siguiente (si el plan llega hasta allá y queda cupo) o va de
   * cortesía (no cuenta). La alternativa, cobrarla aparte, no pasa por aquí.
   */
  async coverOverQuota(
    ctx: TenantContext,
    id: string,
    appointmentId: string,
    mode: 'NEXT_CYCLE' | 'COURTESY',
  ) {
    await this.findScoped(ctx, id);
    await this.tenantHelper.assertScopedRecord('barberAppointment', ctx, appointmentId, 'Appointment');
    await this.prisma.$transaction(async (tx) => {
      const appt = await tx.barberAppointment.findUniqueOrThrow({
        where: { id: appointmentId },
        select: {
          customerId: true,
          status: true,
          scheduledAt: true,
          servedAt: true,
          coveredByChargeId: true,
          charges: { where: { voidedAt: null }, select: { id: true } },
        },
      });
      if (appt.coveredByChargeId || appt.charges.length > 0) {
        throw new ConflictException({
          code: 'ALREADY_CHARGED',
          message: 'Esta sesión ya está cubierta o cobrada',
        });
      }
      if (NOT_CONSUMED_STATUSES.includes(appt.status)) {
        throw new BadRequestException('Solo se cubren sesiones en las que vino');
      }
      const charge = await tx.barberCharge.findUniqueOrThrow({
        where: { id },
        include: CHARGE_INCLUDE,
      });
      if (charge.customerId !== appt.customerId) {
        throw new BadRequestException('El plan es de otro cliente');
      }
      if (charge.sessionsPerMonth === null) {
        throw new BadRequestException('Este plan no tiene cupo mensual');
      }
      const day = calendarDayCO(appt.servedAt ?? appt.scheduledAt);
      if (mode === 'NEXT_CYCLE') {
        const next = addDays(planCycle(dayOf(charge.startsOn), day, this.freezesOf(charge)).end, 1);
        const endsOn = dayOf(charge.endsOn);
        if (endsOn && next > endsOn) {
          throw new BadRequestException(
            'El plan no llega al mes siguiente: cóbrala aparte o como cortesía',
          );
        }
        if (this.cycleUsage(charge, next).used >= charge.sessionsPerMonth) {
          throw new BadRequestException('El mes siguiente ya tiene el cupo lleno');
        }
      }
      await tx.barberAppointment.update({
        where: { id: appointmentId },
        data: { coveredByChargeId: id, quotaMode: mode, priceCOP: 0 },
      });
    });
    return this.findOne(ctx, id);
  }

  /**
   * Valor de una sesión de un plan: su precio de lista entre las sesiones del
   * mes (Personalizado 240.000 / 8 = 30.000). Un paquete, entre sus sesiones.
   * null si el plan no cuenta sesiones.
   */
  private perSessionCOP(row: ChargeRow): number | null {
    const price = row.service?.priceCOP ?? null;
    const perMonth = row.sessionsPerMonth ?? row.service?.sessionsPerMonth ?? null;
    if (price && perMonth) return Math.round(price / perMonth);
    if (row.sessionsTotal) return Math.round(row.totalCOP / row.sessionsTotal);
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
