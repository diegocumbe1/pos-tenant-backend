import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { calendarDayCO } from '../../../common/date.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { isCompletedStatus } from '../../shared/appointment-status';
import { appointmentPriceCOP } from '../../shared/duration-price';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import {
  BarberChargesService,
  CHARGE_INCLUDE,
  NOT_CONSUMED_STATUSES,
} from './barber-charges.service';
import { CustomerPaymentDto } from './dto/barber-charge.dto';

/** Lo que el cliente ya no va a hacer: no se cobra ni cuenta como visita. */
const INACTIVE = new Set(NOT_CONSUMED_STATUSES.map((s) => s.toLowerCase()));

type AccountAppointment = {
  id: string;
  scheduledAt: string;
  scheduledEnd: string;
  servedAt: string | null;
  status: string;
  serviceId: string;
  serviceName: string;
  color: string | null;
  staffName: string | null;
  priceCOP: number;
  notes: string | null;
  /** Su cobro propio (no anulado), si lo tiene. */
  chargeId: string | null;
  /** El cobro agrupado o el plan que la cubre, si lo hay. */
  coveredByChargeId: string | null;
  /** Ya pasó y nadie la marcó completada ni cancelada. */
  needsClosing: boolean;
};

/**
 * La cuenta de un cliente de agenda, en el orden en que se actúa: qué está por
 * aprobar, qué viene, qué se le debe cobrar, qué saldos tiene y qué ha dejado.
 *
 * LO PAGADO usa la regla de Finanzas → Ventas y del dashboard: pagos no
 * anulados de cobros no anulados + citas completadas sin ningún cobro y sin
 * plan que las cubra (contado implícito). Las tres pantallas dicen lo mismo.
 */
@Injectable()
export class BarberCustomerAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
    private readonly charges: BarberChargesService,
  ) {}

  async account(ctx: TenantContext, customerId: string) {
    await this.tenantHelper.assertScopedRecord(
      'barberCustomer',
      ctx,
      customerId,
      'Customer',
    );
    const scope = { tenantId: ctx.tenantId, branchId: ctx.branchId };
    const [customer, appts, chargeRows] = await Promise.all([
      this.prisma.barberCustomer.findUniqueOrThrow({
        where: { id: customerId },
        select: { id: true, name: true, phone: true, createdAt: true },
      }),
      this.prisma.barberAppointment.findMany({
        where: { ...scope, customerId },
        select: {
          id: true,
          scheduledAt: true,
          scheduledEnd: true,
          servedAt: true,
          status: true,
          priceCOP: true,
          notes: true,
          serviceId: true,
          classSessionId: true,
          coveredByChargeId: true,
          charges: { select: { id: true, voidedAt: true } },
          staff: { select: { name: true } },
          service: {
            select: {
              name: true,
              color: true,
              priceCOP: true,
              durationMin: true,
              durationOptions: true,
            },
          },
        },
        orderBy: { scheduledAt: 'asc' },
      }),
      this.prisma.barberCharge.findMany({
        where: { ...scope, customerId },
        include: CHARGE_INCLUDE,
        orderBy: { chargedAt: 'asc' },
      }),
    ]);

    const now = Date.now();
    const today = calendarDayCO(new Date());

    const toItem = (a: (typeof appts)[number]): AccountAppointment => {
      const status = a.status.toLowerCase();
      const ownCharge = a.charges.find((c) => !c.voidedAt);
      return {
        id: a.id,
        scheduledAt: a.scheduledAt.toISOString(),
        scheduledEnd: a.scheduledEnd.toISOString(),
        servedAt: a.servedAt?.toISOString() ?? null,
        status,
        serviceId: a.serviceId,
        serviceName: a.service.name,
        color: a.service.color ?? null,
        staffName: a.staff?.name ?? null,
        priceCOP: appointmentPriceCOP(a),
        notes: a.notes,
        chargeId: ownCharge?.id ?? null,
        coveredByChargeId: a.coveredByChargeId,
        needsClosing:
          !isCompletedStatus(status) &&
          !INACTIVE.has(status) &&
          status !== 'pending' &&
          a.scheduledAt.getTime() < now,
      };
    };

    // Las asistencias a clase viven en Clases: aquí solo citas uno a uno.
    const items = appts.filter((a) => !a.classSessionId).map(toItem);

    const pendingApproval = items.filter((a) => a.status === 'pending');
    const upcoming = items.filter(
      (a) =>
        a.status !== 'pending' &&
        !INACTIVE.has(a.status) &&
        !isCompletedStatus(a.status) &&
        new Date(a.scheduledAt).getTime() >= now,
    );
    // Por cobrar: ya pasó (o se completó), no está cancelada, sin cobro propio y
    // sin plan ni cobro agrupado que la cubra.
    const toCharge = items.filter(
      (a) =>
        (isCompletedStatus(a.status) || a.needsClosing) &&
        !a.chargeId &&
        !a.coveredByChargeId,
    );
    const history = items
      .filter((a) => isCompletedStatus(a.status) || INACTIVE.has(a.status))
      .sort((a, b) =>
        (b.servedAt ?? b.scheduledAt).localeCompare(
          a.servedAt ?? a.scheduledAt,
        ),
      )
      .slice(0, 100);

    const dtos = chargeRows.map((row) => this.charges.toDto(row, today));
    const groupIds = dtos.filter((c) => c.isGroup).map((c) => c.id);
    const groupItems = await this.charges.groupItems(groupIds);
    const withItems = dtos.map((c) =>
      c.isGroup ? { ...c, items: groupItems.get(c.id) ?? [] } : c,
    );
    const openCharges = withItems
      .filter((c) => !c.voidedAt && c.balanceCOP > 0)
      .sort((a, b) => a.chargedAt.localeCompare(b.chargedAt));

    // ─── Valor del cliente ──────────────────────────────────────────────────
    const completed = appts.filter((a) => isCompletedStatus(a.status));
    const servedDay = (a: (typeof appts)[number]) =>
      a.servedAt ?? a.scheduledAt;
    // Contado implícito: completada, sin NINGÚN cobro (ni anulado, igual que el
    // resumen de cobros) y sin plan que la cubra.
    const implicit = completed.filter(
      (a) =>
        !a.classSessionId && !a.coveredByChargeId && a.charges.length === 0,
    );
    const byService = new Map<
      string,
      { serviceId: string; name: string; count: number; paidCOP: number }
    >();
    const bucket = (id: string, name: string) => {
      const entry = byService.get(id) ?? {
        serviceId: id,
        name,
        count: 0,
        paidCOP: 0,
      };
      byService.set(id, entry);
      return entry;
    };
    for (const a of completed) bucket(a.serviceId, a.service.name).count += 1;
    for (const a of implicit) {
      bucket(a.serviceId, a.service.name).paidCOP += appointmentPriceCOP(a);
    }
    const serviceNameById = new Map(
      appts.map((a) => [a.serviceId, a.service.name]),
    );
    for (const c of withItems) {
      if (c.voidedAt || c.paidCOP === 0) continue;
      const groupList = c.isGroup ? (groupItems.get(c.id) ?? []) : [];
      const groupTotal = groupList.reduce((acc, i) => acc + i.priceCOP, 0);
      if (groupList.length > 0 && groupTotal > 0) {
        // Un cobro agrupado reparte lo pagado según lo que vale cada cita.
        let assigned = 0;
        groupList.forEach((item, idx) => {
          const share =
            idx === groupList.length - 1
              ? c.paidCOP - assigned
              : Math.round((c.paidCOP * item.priceCOP) / groupTotal);
          assigned += share;
          bucket(item.serviceId, item.serviceName).paidCOP += share;
        });
      } else if (c.serviceId) {
        bucket(
          c.serviceId,
          c.serviceName ?? serviceNameById.get(c.serviceId) ?? c.concept,
        ).paidCOP += c.paidCOP;
      } else {
        bucket(`concept:${c.concept.toLowerCase()}`, c.concept).paidCOP +=
          c.paidCOP;
      }
    }
    const paidCOP =
      withItems
        .filter((c) => !c.voidedAt)
        .reduce((acc, c) => acc + c.paidCOP, 0) +
      implicit.reduce((acc, a) => acc + appointmentPriceCOP(a), 0);
    const servedDays = completed.map((a) => servedDay(a).toISOString()).sort();

    const toChargeCOP = toCharge.reduce((acc, a) => acc + a.priceCOP, 0);
    const balanceCOP = openCharges.reduce((acc, c) => acc + c.balanceCOP, 0);

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        createdAt: customer.createdAt.toISOString(),
      },
      totals: {
        /** Lo que debe hoy: lo por cobrar + saldos de cobros abiertos. */
        owedCOP: toChargeCOP + balanceCOP,
        toChargeCOP,
        balanceCOP,
        /** Lo agendado que viene (por aprobar incluido). */
        upcomingCOP: [...pendingApproval, ...upcoming].reduce(
          (acc, a) => acc + a.priceCOP,
          0,
        ),
      },
      value: {
        paidCOP,
        servicesCount: completed.length,
        avgTicketCOP: completed.length
          ? Math.round(paidCOP / completed.length)
          : 0,
        firstVisitAt: servedDays[0] ?? null,
        lastVisitAt: servedDays[servedDays.length - 1] ?? null,
        byService: [...byService.values()]
          .filter((s) => s.count > 0 || s.paidCOP > 0)
          .sort((a, b) => b.paidCOP - a.paidCOP || b.count - a.count),
      },
      pendingApproval,
      upcoming,
      toCharge,
      openCharges,
      history,
    };
  }

  /**
   * Un abono del cliente repartido entre sus cobros con saldo. Todo en una
   * transacción con los saldos leídos dentro: dos abonos al tiempo no pueden
   * pasarse de lo que debe.
   */
  async pay(ctx: TenantContext, customerId: string, dto: CustomerPaymentDto) {
    await this.tenantHelper.assertScopedRecord(
      'barberCustomer',
      ctx,
      customerId,
      'Customer',
    );
    // 'YYYY-MM-DD' se ancla a la hora actual de Colombia y no se acepta futuro.
    const paidAt = dto.paidAt
      ? this.charges.resolveInstant(dto.paidAt)
      : new Date();
    const chargeIds = await this.prisma.$transaction(async (tx) => {
      const open = await tx.barberCharge.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          customerId,
          voidedAt: null,
        },
        include: { payments: true },
        orderBy: [{ chargedAt: 'asc' }],
      });
      const balances = new Map(
        open
          .map(
            (c) =>
              [
                c.id,
                c.totalCOP -
                  c.payments
                    .filter((p) => !p.voidedAt)
                    .reduce((acc, p) => acc + p.amountCOP, 0),
              ] as const,
          )
          .filter(([, balance]) => balance > 0),
      );
      const totalBalance = [...balances.values()].reduce((a, b) => a + b, 0);
      if (totalBalance === 0) {
        throw new BadRequestException(
          'No tiene saldos pendientes. Cobra primero las citas por cobrar.',
        );
      }
      if (dto.amountCOP > totalBalance) {
        throw new BadRequestException(
          `El abono es mayor que lo que debe (${totalBalance})`,
        );
      }

      let plan: Array<{ chargeId: string; amountCOP: number }>;
      if (dto.mode === 'MANUAL') {
        plan = (dto.allocations ?? []).filter((a) => a.amountCOP > 0);
        const sum = plan.reduce((acc, a) => acc + a.amountCOP, 0);
        if (sum !== dto.amountCOP) {
          throw new BadRequestException(
            'El reparto no suma el valor del abono',
          );
        }
        for (const a of plan) {
          const balance = balances.get(a.chargeId);
          if (balance === undefined) {
            throw new NotFoundException('Uno de los cobros no tiene saldo');
          }
          if (a.amountCOP > balance) {
            throw new BadRequestException(
              'Un abono es mayor que el saldo de su cobro',
            );
          }
        }
      } else {
        // El más antiguo primero: es la deuda que más pesa.
        plan = [];
        let left = dto.amountCOP;
        for (const [chargeId, balance] of balances) {
          if (left === 0) break;
          const amount = Math.min(left, balance);
          plan.push({ chargeId, amountCOP: amount });
          left -= amount;
        }
      }

      for (const a of plan) {
        await tx.barberPayment.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            chargeId: a.chargeId,
            amountCOP: a.amountCOP,
            method: dto.method,
            paidAt,
            note: dto.note ?? null,
            userId: ctx.userId,
            userName: ctx.name,
          },
        });
      }
      return plan.map((a) => a.chargeId);
    });
    return { ok: true, chargeIds };
  }
}
