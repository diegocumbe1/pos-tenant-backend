import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { PrismaService } from '../prisma/prisma.service';
import { calendarDayCO, formatDateCO } from '../common/date.util';
import { toExpenseDto } from './expense-dto';

import {
  PLATFORM_SUBSCRIPTION_SOURCE,
  platformPeriodKey,
} from './platform-subscription-period';

export { PLATFORM_SUBSCRIPTION_SOURCE };

/** Cuántos pagos recientes se ofrecen para registrar. */
const RECENT_PAYMENTS = 12;

/**
 * Cobros que el negocio puede registrar como gasto: los pagados y las
 * cortesías (un mes regalado ES un gasto de $0 con descuento del 100%). Las
 * notas crédito ('credit') no: son ajustes internos de la plataforma.
 */
const REGISTRABLE_KINDS = ['payment', 'bonus'];

/** Lo que valía el cobro, cuánto se descontó y cuánto se pagó. */
function discountOf(
  payment: {
    amount: number;
    officialPrice: number | null;
    discountApplied: number;
  },
  fallbackPrice: number | null,
) {
  const listAmount =
    payment.officialPrice ??
    (payment.discountApplied > 0
      ? payment.amount + payment.discountApplied
      : payment.amount || fallbackPrice || 0);
  const discount = Math.max(0, listAmount - payment.amount);
  return {
    listAmount,
    discount,
    discountPct: listAmount > 0 ? Math.round((discount / listAmount) * 100) : 0,
  };
}

/**
 * La suscripción a Lynko vista DESDE EL NEGOCIO, para registrarla como gasto.
 *
 * LA GESTIONA EL DUEÑO. Lynko no escribe gastos en las finanzas del cliente por
 * su cuenta: aquí solo se le muestra lo que la plataforma le cobró y un botón
 * para registrarlo. El dueño decide si lo registra, cuándo y en qué sede.
 *
 * Solo lectura sobre las tablas de la plataforma (`subscriptions`,
 * `subscription_payments`), y siempre del propio tenant: un negocio nunca ve
 * nada de otro, ni datos internos del backoffice (quién aprobó un descuento,
 * comisiones de la pasarela…).
 */
@Injectable()
export class PlatformSubscriptionExpenseService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(ctx: TenantContext) {
    const [subscription, payments, template] = await Promise.all([
      this.prisma.subscription.findUnique({
        where: { tenantId: ctx.tenantId },
        select: {
          plan: true,
          status: true,
          billingCycle: true,
          agreedPriceCOP: true,
          priceCOP: true,
          nextPaymentDueAt: true,
        },
      }),
      // Pagos y cortesías. Una cortesía se registra como gasto de $0 con su
      // descuento: así el dueño ve lo que se ahorró y su histórico no tiene
      // huecos de meses "sin Lynko".
      this.prisma.subscriptionPayment.findMany({
        where: { tenantId: ctx.tenantId, kind: { in: REGISTRABLE_KINDS } },
        orderBy: { paidAt: 'desc' },
        take: RECENT_PAYMENTS,
        select: {
          id: true,
          kind: true,
          plan: true,
          amount: true,
          officialPrice: true,
          discountApplied: true,
          discountReason: true,
          currency: true,
          billingCycle: true,
          periodStart: true,
          periodEnd: true,
          paidAt: true,
        },
      }),
      this.prisma.expenseTemplate.findFirst({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          sourceType: PLATFORM_SUBSCRIPTION_SOURCE,
          deletedAt: null,
        },
        select: { id: true },
      }),
    ]);

    if (!subscription && payments.length === 0) return null;

    // Un pago se registra una sola vez en todo el negocio, no una por sede. Y
    // cuenta como registrado si ese periodo ya se pagó desde el gasto
    // recurrente de Lynko: los dos caminos son el mismo cobro.
    const registered = payments.length
      ? await this.prisma.expense.findMany({
          where: {
            tenantId: ctx.tenantId,
            sourceType: PLATFORM_SUBSCRIPTION_SOURCE,
          },
          select: {
            id: true,
            sourceId: true,
            branchId: true,
            incurredAt: true,
          },
        })
      : [];
    const byPayment = new Map(
      registered.filter((r) => r.sourceId).map((r) => [r.sourceId, r]),
    );
    const unlinked = registered.filter((r) => !r.sourceId);
    const currentPrice =
      subscription?.agreedPriceCOP ?? subscription?.priceCOP ?? null;
    const matchFor = (payment: (typeof payments)[number]) => {
      const direct = byPayment.get(payment.id);
      if (direct) return direct;
      const annual = payment.billingCycle === 'yearly';
      const key = platformPeriodKey(payment.paidAt, annual);
      return unlinked.find(
        (r) => platformPeriodKey(r.incurredAt, annual) === key,
      );
    };

    return {
      plan: subscription?.plan ?? payments[0]?.plan ?? null,
      status: subscription?.status ?? null,
      billingCycle: subscription?.billingCycle ?? null,
      /** Lo que se cobra hoy por ciclo (precio pactado). */
      priceCOP: subscription?.agreedPriceCOP ?? subscription?.priceCOP ?? null,
      nextPaymentDueAt: subscription?.nextPaymentDueAt
        ? calendarDayCO(subscription.nextPaymentDueAt)
        : null,
      /** Si ya existe el gasto recurrente de Lynko en esta sede. */
      templateId: template?.id ?? null,
      payments: payments.map((payment) => {
        const expense = matchFor(payment);
        const { listAmount, discount, discountPct } = discountOf(
          payment,
          currentPrice,
        );
        return {
          id: payment.id,
          /** 'payment' = cobro pagado; 'bonus' = cortesía (pagó $0). */
          kind: payment.kind,
          plan: payment.plan,
          /** Lo pagado. Puede ser 0. */
          amount: payment.amount,
          /** Lo que valía sin descuento. */
          listAmount,
          discount,
          discountPct,
          /** Motivo del descuento ("cliente fundador"…), si la plataforma lo anotó. */
          discountReason: payment.discountReason,
          currency: payment.currency,
          paidOn: calendarDayCO(payment.paidAt),
          periodStart: calendarDayCO(payment.periodStart),
          periodEnd: calendarDayCO(payment.periodEnd),
          /** Solo se puede registrar en pesos; un cobro en USD se muestra y ya. */
          canRegister: payment.currency === 'COP',
          registeredExpenseId: expense?.id ?? null,
          registeredInOtherBranch:
            !!expense && expense.branchId !== ctx.branchId,
        };
      }),
    };
  }

  /**
   * Registra un pago a Lynko como gasto de PLATAFORMA en la sede actual.
   *
   * Idempotente por pago: si ya se registró (en cualquier sede), devuelve ese
   * gasto en vez de crear otro.
   */
  async registerPayment(ctx: TenantContext, paymentId: string) {
    const [payment, subscription] = await Promise.all([
      this.prisma.subscriptionPayment.findFirst({
        where: {
          id: paymentId,
          tenantId: ctx.tenantId,
          kind: { in: REGISTRABLE_KINDS },
        },
      }),
      this.prisma.subscription.findUnique({
        where: { tenantId: ctx.tenantId },
        select: { agreedPriceCOP: true, priceCOP: true },
      }),
    ]);
    if (!payment || payment.currency !== 'COP') {
      throw new NotFoundException(
        `Subscription payment ${paymentId} not found`,
      );
    }
    const { discount, discountPct } = discountOf(
      payment,
      subscription?.agreedPriceCOP ?? subscription?.priceCOP ?? null,
    );
    // Un cobro de $0 sin descuento no dice nada: no hay gasto que anotar.
    if (payment.amount <= 0 && discount <= 0) {
      throw new NotFoundException(
        `Subscription payment ${paymentId} not found`,
      );
    }

    const existing = await this.prisma.expense.findFirst({
      where: {
        tenantId: ctx.tenantId,
        sourceType: PLATFORM_SUBSCRIPTION_SOURCE,
        sourceId: paymentId,
      },
    });
    if (existing) return toExpenseDto(existing);

    // Ese periodo ya se registró pagando la fecha del gasto recurrente de
    // Lynko: se le pone el origen a ese gasto en vez de crear otro.
    const annual = payment.billingCycle === 'yearly';
    const sameCharge = (
      await this.prisma.expense.findMany({
        where: {
          tenantId: ctx.tenantId,
          sourceType: PLATFORM_SUBSCRIPTION_SOURCE,
          sourceId: null,
        },
      })
    ).find(
      (row) =>
        platformPeriodKey(row.incurredAt, annual) ===
        platformPeriodKey(payment.paidAt, annual),
    );
    if (sameCharge) {
      const linked = await this.prisma.expense.update({
        where: { id: sameCharge.id },
        data: { sourceId: paymentId },
      });
      return toExpenseDto(linked);
    }

    const expense = await this.prisma.expense.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        category: 'PLATFORM',
        concept: `Suscripción Lynko · Plan ${payment.plan}${payment.kind === 'bonus' ? ' · cortesía' : ''}`,
        // Lo PAGADO, aunque sea 0. El descuento va aparte y no suma al gasto.
        amountCOP: payment.amount,
        discountCOP: discount || null,
        incurredAt: payment.paidAt,
        frequency: payment.billingCycle === 'yearly' ? 'ANNUAL' : 'MONTHLY',
        isRecurring: true,
        nature: 'FIXED',
        note: [
          `Periodo ${formatDateCO(payment.periodStart)} – ${formatDateCO(payment.periodEnd)}`,
          discount > 0 ? `descuento ${discountPct}%` : null,
          payment.discountReason,
        ]
          .filter(Boolean)
          .join(' · '),
        sourceType: PLATFORM_SUBSCRIPTION_SOURCE,
        sourceId: paymentId,
      },
    });
    return toExpenseDto(expense);
  }
}
