import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BillingGroupCharge, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformService } from '../../platform/platform.service';
import { BillingGroupsService } from '../../platform/billing-groups/billing-groups.service';
import { calendarDayCO } from '../../common/date.util';
import { buildReference, copToCents } from '../checkout-url';
import type { WompiTransactionView } from '../event-checksum';
import { FeeMethod, quoteFee } from '../fee-calculator';
import { FeeRatesService } from './fee-rates.service';
import { WompiClient } from './wompi.client';
import type { SettleResult } from './charges.service';

const WEBHOOK_ACTOR = 'wompi-webhook';

function toFeeMethod(paymentMethodType: string | null): FeeMethod {
  switch (paymentMethodType) {
    case 'CARD':
      return 'CARD_ONLINE';
    case 'PSE':
      return 'PSE';
    case 'NEQUI':
    case 'DAVIPLATA':
    case 'BANCOLOMBIA_TRANSFER':
    case 'BANCOLOMBIA_QR':
      return 'NEQUI';
    default:
      return 'CARD_ONLINE';
  }
}

function addBusinessDays(from: Date, days: number): Date {
  const result = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return result;
}

/**
 * Cobro de un combo: UN link (o un pago manual) por la suma de los negocios.
 *
 * El padre (`billing_group_charges`) lleva la referencia, el link, la comisión
 * y la conciliación. Cada negocio tiene su línea (`subscription_charges` con
 * `groupChargeId`) y, al pagarse, su propio SubscriptionPayment por el valor
 * exacto de su línea: así cada negocio sigue sabiendo qué pagó y su periodo
 * avanza igual que con un cobro suelto. La comisión se registra UNA vez.
 */
@Injectable()
export class GroupChargesService {
  private readonly logger = new Logger(GroupChargesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wompi: WompiClient,
    private readonly platform: PlatformService,
    private readonly groups: BillingGroupsService,
    private readonly rates: FeeRatesService,
  ) {}

  async list(groupId: string) {
    const charges = await this.prisma.billingGroupCharge.findMany({
      where: { billingGroupId: groupId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        lines: {
          select: { id: true, tenantId: true, amount: true, status: true },
        },
      },
    });
    return { charges };
  }

  async create(
    groupId: string,
    input: {
      termMonths: number;
      provider?: 'wompi' | 'manual';
      expiresAt?: string;
      customerEmail?: string;
    },
    actorUserId: string,
  ) {
    const quote = await this.groups.quote(groupId, input.termMonths);
    if (quote.blocked) {
      const reasons = quote.issues
        .filter((i) => i.level === 'error')
        .map((i) => i.message);
      throw new BadRequestException(
        reasons.length > 0
          ? reasons.join(' ')
          : 'No hay nada por cobrar en este periodo.',
      );
    }

    const provider = input.provider ?? 'wompi';
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    const reference = buildReference({
      tenantSlug: `COMBO${quote.groupName}`,
      period: calendarDayCO(quote.periodStart).replace(/-/g, '').slice(0, 6),
      nonce: randomBytes(4).toString('hex'),
    });

    // El link se arma antes de guardar: si la pasarela está mal configurada,
    // no debe quedar un cobro que nadie puede pagar.
    const checkout =
      provider === 'wompi'
        ? await this.wompi.buildCheckout({
            reference,
            amountCOP: quote.amount,
            expiresAt,
            customer: input.customerEmail
              ? { email: input.customerEmail }
              : undefined,
          })
        : null;

    const payableLines = quote.lines.filter((l) => l.amount > 0);
    const breakdown = JSON.parse(
      JSON.stringify(quote),
    ) as Prisma.InputJsonValue;

    return this.prisma.$transaction(async (tx) => {
      const parent = await tx.billingGroupCharge.create({
        data: {
          billingGroupId: groupId,
          termMonths: quote.termMonths,
          periodStart: quote.periodStart,
          periodEnd: quote.periodEnd,
          listAmount: quote.listAmount,
          discountAmount: quote.discountAmount,
          amount: quote.amount,
          breakdown,
          provider,
          reference,
          checkoutUrl: checkout?.url ?? null,
          expiresAt,
          createdByUserId: actorUserId,
        },
      });
      const tenants = await tx.tenant.findMany({
        where: { id: { in: payableLines.map((l) => l.tenantId) } },
        select: {
          id: true,
          plan: true,
          subscription: { select: { id: true } },
        },
      });
      for (const [index, line] of payableLines.entries()) {
        const tenant = tenants.find((t) => t.id === line.tenantId);
        await tx.subscriptionCharge.create({
          data: {
            tenantId: line.tenantId,
            subscriptionId: tenant?.subscription?.id ?? null,
            plan: tenant?.plan ?? quote.planCode ?? 'BASIC',
            termMonths: quote.termMonths,
            periodStart: line.periodStart,
            periodEnd: line.periodEnd,
            listAmount: line.listAmount,
            discountAmount: line.discountAmount,
            discountReason: line.discountReason,
            amount: line.amount,
            provider,
            // Las líneas no se pagan solas: la referencia y el link son del padre.
            reference: `${reference}-${index + 1}`,
            checkoutUrl: checkout?.url ?? '',
            expiresAt,
            createdByUserId: actorUserId,
            groupChargeId: parent.id,
          },
        });
      }
      return tx.billingGroupCharge.findUniqueOrThrow({
        where: { id: parent.id },
        include: { lines: true },
      });
    });
  }

  async cancel(chargeId: string) {
    const charge = await this.load(chargeId);
    if (charge.status === 'paid')
      throw new BadRequestException('Un cobro pagado no se cancela');
    await this.prisma.$transaction([
      this.prisma.billingGroupCharge.update({
        where: { id: chargeId },
        data: { status: 'canceled', statusDetail: 'Cancelado a mano' },
      }),
      this.prisma.subscriptionCharge.updateMany({
        where: { groupChargeId: chargeId },
        data: { status: 'canceled', statusDetail: 'Cancelado con el combo' },
      }),
    ]);
    return this.load(chargeId);
  }

  /** Red de seguridad cuando el webhook no llegó: pregunta a Wompi. */
  async verify(
    chargeId: string,
  ): Promise<SettleResult & { charge: BillingGroupCharge }> {
    const charge = await this.load(chargeId);
    if (charge.provider !== 'wompi') {
      return {
        outcome: 'pending',
        detail: 'Es un cobro manual: regístralo con "Registrar pago".',
        charge,
      };
    }
    const tx = charge.providerTxId
      ? await this.wompi.getTransaction(charge.providerTxId)
      : await this.wompi.findTransactionByReference(charge.reference);
    await this.prisma.billingGroupCharge.update({
      where: { id: chargeId },
      data: { lastCheckedAt: new Date() },
    });
    if (!tx) {
      return {
        outcome: 'pending',
        detail: 'Wompi no tiene ninguna transacción para esta referencia',
        charge: await this.load(chargeId),
      };
    }
    const result = await this.settle(charge, tx);
    return { ...result, charge: await this.load(chargeId) };
  }

  /**
   * Pago manual (Bre-B, transferencia, efectivo). Sin comisión: Bre-B es
   * gratis. Crea el pago de cada negocio igual que la pasarela.
   */
  async registerManual(
    chargeId: string,
    input: {
      paidAt?: string;
      method?: string;
      reference?: string;
      note?: string;
    },
    actorUserId: string,
  ) {
    const charge = await this.load(chargeId);
    if (charge.status === 'paid')
      throw new BadRequestException('Este cobro ya está pagado');
    if (charge.status === 'canceled')
      throw new BadRequestException('Este cobro está cancelado');
    const claimed = await this.prisma.billingGroupCharge.updateMany({
      where: { id: chargeId, status: { notIn: ['paid', 'canceled'] } },
      data: { status: 'paid', provider: 'manual' },
    });
    if (claimed.count === 0)
      throw new BadRequestException('Otro usuario ya registró este pago');

    const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
    await this.payLines(charge, {
      paidAt,
      method: input.method ?? 'transfer',
      reference: input.reference ?? charge.reference,
      note: input.note ?? `Combo ${charge.reference} · pago manual`,
      actor: actorUserId,
    });
    await this.prisma.billingGroupCharge.update({
      where: { id: chargeId },
      data: {
        paidAt,
        statusDetail: null,
        paymentMethodType: input.method ?? 'transfer',
      },
    });
    return this.load(chargeId);
  }

  /**
   * Llamado desde el webhook cuando la referencia no es de un cobro suelto.
   * Devuelve null si tampoco es de un combo (el webhook lo registra como
   * referencia desconocida).
   */
  async settleByReference(
    reference: string,
    tx: WompiTransactionView,
  ): Promise<SettleResult | null> {
    const charge = await this.prisma.billingGroupCharge.findUnique({
      where: { reference },
    });
    if (!charge) return null;
    return this.settle(charge, tx);
  }

  private async settle(
    charge: BillingGroupCharge,
    tx: WompiTransactionView,
  ): Promise<SettleResult> {
    if (charge.status === 'paid') {
      return {
        outcome: 'duplicate',
        detail: 'El combo ya estaba conciliado',
        chargeId: charge.id,
      };
    }
    if (tx.status !== 'APPROVED') {
      const failed = ['DECLINED', 'ERROR', 'VOIDED'].includes(tx.status ?? '');
      await this.prisma.billingGroupCharge.update({
        where: { id: charge.id },
        data: {
          status: failed ? 'failed' : charge.status,
          statusDetail: `Wompi: ${tx.status ?? 'sin estado'}`,
          providerTxId: charge.providerTxId ?? tx.id,
          paymentMethodType: tx.paymentMethodType,
        },
      });
      return {
        outcome: 'not_approved',
        detail: `La transacción está en ${tx.status ?? 'estado desconocido'}`,
        chargeId: charge.id,
      };
    }
    if (
      tx.amountInCents !== null &&
      tx.amountInCents !== copToCents(charge.amount)
    ) {
      await this.prisma.billingGroupCharge.update({
        where: { id: charge.id },
        data: {
          statusDetail: `Monto distinto: Wompi cobró ${tx.amountInCents / 100} y el combo era ${charge.amount}`,
          providerTxId: charge.providerTxId ?? tx.id,
        },
      });
      return {
        outcome: 'amount_mismatch',
        detail: 'El monto aprobado no coincide con el del combo',
        chargeId: charge.id,
      };
    }

    // Claim atómico: dos webhooks simultáneos no pueden pagar dos veces.
    const claimed = await this.prisma.billingGroupCharge.updateMany({
      where: {
        id: charge.id,
        status: { not: 'paid' },
        OR: [{ providerTxId: null }, { providerTxId: tx.id }],
      },
      data: { status: 'paid', providerTxId: tx.id ?? charge.providerTxId },
    });
    if (claimed.count === 0) {
      return {
        outcome: 'duplicate',
        detail: 'Otro aviso tomó este combo primero',
        chargeId: charge.id,
      };
    }

    const paidAt = tx.finalizedAt ? new Date(tx.finalizedAt) : new Date();
    const feeMethod = toFeeMethod(tx.paymentMethodType);
    const rate = await this.rates.rateAt(feeMethod, paidAt);
    const fee = quoteFee({ amountCOP: charge.amount, rate });

    await this.payLines(charge, {
      paidAt,
      method: 'card',
      reference: tx.id ?? charge.reference,
      note: `Combo ${charge.reference} · ${tx.paymentMethodType ?? 'pasarela'}`,
      actor: WEBHOOK_ACTOR,
    });

    await this.prisma.billingGroupCharge.update({
      where: { id: charge.id },
      data: {
        statusDetail: null,
        paidAt,
        paymentMethodType: tx.paymentMethodType,
        feeMethod,
        gatewayFee: fee.totalCost,
        withheld: fee.totalWithheld,
        netSettled: fee.deposited,
        expectedSettlementAt: addBusinessDays(paidAt, rate.settlementDays),
      },
    });

    // La comisión es UNA por transacción: se registra en el padre, no por línea.
    if (fee.totalCost > 0) {
      await this.prisma.platformExpense.create({
        data: {
          category: 'fees',
          concept: `Comisión pasarela · ${charge.reference}`,
          vendor: 'Wompi',
          amount: fee.totalCost,
          currency: 'COP',
          kind: 'one_time',
          incurredAt: paidAt,
          note: `Transacción ${tx.id ?? 's/n'} · ${tx.paymentMethodType ?? ''} · combo`.trim(),
          createdByUserId: WEBHOOK_ACTOR,
        },
      });
    }
    return {
      outcome: 'paid',
      detail: `Combo pagado por ${charge.amount} COP`,
      chargeId: charge.id,
    };
  }

  /** Un SubscriptionPayment por negocio, por el valor exacto de su línea. */
  private async payLines(
    charge: BillingGroupCharge,
    input: {
      paidAt: Date;
      method: string;
      reference: string;
      note: string;
      actor: string;
    },
  ) {
    const lines = await this.prisma.subscriptionCharge.findMany({
      where: { groupChargeId: charge.id, status: { not: 'paid' } },
    });
    for (const line of lines) {
      try {
        const payment = await this.platform.createPayment(
          line.tenantId,
          {
            amount: line.amount,
            officialPrice: line.listAmount ?? line.amount,
            discountApplied: line.discountAmount,
            discountReason: line.discountReason ?? undefined,
            currency: 'COP',
            periodStart: calendarDayCO(line.periodStart),
            periodEnd: calendarDayCO(line.periodEnd),
            paidAt: input.paidAt.toISOString(),
            method: input.method,
            reference: input.reference,
            note: input.note,
            extendPeriod: true,
          },
          input.actor,
        );
        await this.prisma.subscriptionCharge.update({
          where: { id: line.id },
          data: {
            status: 'paid',
            statusDetail: null,
            paidAt: input.paidAt,
            paymentId: payment.id,
          },
        });
      } catch (err) {
        // Una línea que falla no debe dejar sin registrar las demás. Queda
        // visible en la línea para reintentarla desde la consola.
        this.logger.error(
          `Línea ${line.id} del combo ${charge.reference} no se pudo pagar: ${(err as Error).message}`,
        );
        await this.prisma.subscriptionCharge.update({
          where: { id: line.id },
          data: {
            statusDetail:
              `Error al registrar el pago: ${(err as Error).message}`.slice(
                0,
                500,
              ),
          },
        });
      }
    }
  }

  private async load(id: string) {
    const charge = await this.prisma.billingGroupCharge.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!charge) throw new NotFoundException(`Cobro ${id} no existe`);
    return charge;
  }
}
