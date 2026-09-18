import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SubscriptionCharge } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformService } from '../../platform/platform.service';
import { PlanPricingService } from '../../platform/pricing/plan-pricing.service';
import { calendarDayCO } from '../../common/date.util';
import { buildReference, copToCents } from '../checkout-url';
import {
  WompiEvent,
  WompiTransactionView,
  checksumMatches,
  readTransaction,
} from '../event-checksum';
import { CreateChargeDto } from '../dto/platform-gateway.dto';
import { GatewaySettingsService } from './gateway-settings.service';
import { WompiClient } from './wompi.client';

/** Quién queda como autor del pago cuando lo registra la pasarela y no una persona. */
const WEBHOOK_ACTOR = 'wompi-webhook';

/** Qué pasó con un evento o una verificación. Se guarda en la bitácora. */
export type SettleOutcome =
  | 'paid'
  | 'duplicate'
  | 'pending'
  | 'not_approved'
  | 'amount_mismatch'
  | 'unknown_reference'
  | 'bad_checksum'
  | 'not_configured'
  | 'wrong_environment'
  | 'error';

export interface SettleResult {
  outcome: SettleOutcome;
  detail: string;
  chargeId?: string;
}

@Injectable()
export class ChargesService {
  private readonly logger = new Logger(ChargesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wompi: WompiClient,
    private readonly settings: GatewaySettingsService,
    private readonly platform: PlatformService,
    private readonly pricing: PlanPricingService,
  ) {}

  // ─── Cobros ─────────────────────────────────────────────────────────────────

  async list(tenantId: string) {
    const charges = await this.prisma.subscriptionCharge.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { charges };
  }

  /**
   * Cuánto costaría cobrarle N meses por adelantado a este tenant, hoy.
   *
   * El super-admin ya no tiene que sacar la cuenta a mano: el formulario pide
   * esto al cambiar el término y muestra lista / descuento comercial /
   * descuento por anticipo / total. Antes el monto se escribía a ojo, y como el
   * formulario no mandaba `listAmount`, TODO cobro quedaba con `discountAmount
   * = 0` — o sea, la rebaja por pagar seis meses no existía en los libros.
   */
  async quote(tenantId: string, termMonths: number) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      include: { subscription: true, vertical: { select: { code: true } } },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);
    if (!tenant.vertical?.code) {
      throw new BadRequestException('El tenant no tiene vertical asignada');
    }

    return this.pricing.quoteCharge({
      verticalCode: tenant.vertical.code,
      planCode: tenant.plan,
      termMonths,
      // El precio pactado manda sobre el de lista: un cliente con tarifa
      // negociada no debe recibir la rebaja comercial dos veces.
      agreedMonthlyCOP:
        tenant.subscription?.agreedPriceCOP ?? tenant.subscription?.priceCOP,
    });
  }

  async create(tenantId: string, dto: CreateChargeDto, actorUserId: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      include: { subscription: true },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    const amount = dto.amount;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('El monto debe ser un entero mayor que 0');
    }

    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);
    if (periodEnd <= periodStart) {
      throw new BadRequestException('El periodo termina antes de empezar');
    }

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    const reference = buildReference({
      tenantSlug: tenant.name,
      period: calendarDayCO(periodStart).replace(/-/g, '').slice(0, 6),
      nonce: randomBytes(4).toString('hex'),
    });

    // Se arma el link ANTES de guardar: si la pasarela está mal configurada, el
    // cobro no debería quedar creado en un estado que nadie puede pagar.
    const checkout = await this.wompi.buildCheckout({
      reference,
      amountCOP: amount,
      expiresAt,
      customer: dto.customerEmail ? { email: dto.customerEmail } : undefined,
    });

    const listAmount = dto.listAmount ?? amount;
    return this.prisma.subscriptionCharge.create({
      data: {
        tenantId,
        subscriptionId: tenant.subscription?.id ?? null,
        plan: tenant.plan,
        termMonths: dto.termMonths ?? 1,
        periodStart,
        periodEnd,
        listAmount,
        discountAmount: Math.max(0, listAmount - amount),
        discountReason: dto.discountReason,
        amount,
        reference,
        checkoutUrl: checkout.url,
        expiresAt,
        createdByUserId: actorUserId,
      },
    });
  }

  async cancel(chargeId: string) {
    const charge = await this.loadCharge(chargeId);
    if (charge.status === 'paid') {
      throw new BadRequestException('Un cobro pagado no se cancela');
    }
    return this.prisma.subscriptionCharge.update({
      where: { id: chargeId },
      data: { status: 'canceled', statusDetail: 'Cancelado a mano' },
    });
  }

  /**
   * Le pregunta a Wompi por este cobro. Es la red de seguridad cuando el
   * webhook no llegó: sin esto, un pago real podría quedarse invisible porque
   * el servidor estaba caído justo en ese minuto.
   */
  async verify(
    chargeId: string,
  ): Promise<SettleResult & { charge: SubscriptionCharge }> {
    const charge = await this.loadCharge(chargeId);

    const tx = charge.providerTxId
      ? await this.wompi.getTransaction(charge.providerTxId)
      : await this.wompi.findTransactionByReference(charge.reference);

    await this.prisma.subscriptionCharge.update({
      where: { id: chargeId },
      data: { lastCheckedAt: new Date() },
    });

    if (!tx) {
      return {
        outcome: 'pending',
        detail: 'Wompi no tiene ninguna transacción para esta referencia',
        charge: await this.loadCharge(chargeId),
      };
    }

    const result = await this.settle(charge, tx);
    return { ...result, charge: await this.loadCharge(chargeId) };
  }

  // ─── Webhook ────────────────────────────────────────────────────────────────

  /**
   * Procesa un evento de Wompi. Siempre deja rastro en `gateway_events`,
   * incluso cuando lo rechaza: un evento con firma inválida es justo lo que uno
   * quiere poder mirar después.
   *
   * Nunca lanza: el controller responde 200 pase lo que pase, porque un 500 le
   * hace a Wompi reintentar durante 24 h un evento que ya está registrado.
   */
  async handleEvent(
    event: WompiEvent,
    headerChecksum?: string,
  ): Promise<SettleResult> {
    const tx = readTransaction(event.data);
    const base = {
      eventType: event.event ?? null,
      transactionId: tx.id,
      reference: tx.reference,
      status: tx.status,
      environment: event.environment ?? null,
      payload: event as unknown as Prisma.InputJsonValue,
    };

    const log = async (
      result: SettleResult,
      checksumOk: boolean,
    ): Promise<SettleResult> => {
      await this.prisma.gatewayEvent.create({
        data: {
          ...base,
          checksumOk,
          handled: result.outcome === 'paid',
          outcome: result.outcome,
          chargeId: result.chargeId ?? null,
        },
      });
      return result;
    };

    try {
      const row = await this.settings.get();
      if (!row.eventsSecret) {
        return log(
          { outcome: 'not_configured', detail: 'Sin secreto de eventos' },
          false,
        );
      }

      // El header y el cuerpo traen el mismo checksum; si vienen distintos,
      // alguien está jugando.
      const bodyChecksum = event.signature?.checksum;
      if (headerChecksum && bodyChecksum && headerChecksum !== bodyChecksum) {
        return log(
          {
            outcome: 'bad_checksum',
            detail: 'El header no coincide con el cuerpo',
          },
          false,
        );
      }
      if (!checksumMatches(event, row.eventsSecret)) {
        return log(
          { outcome: 'bad_checksum', detail: 'Firma inválida' },
          false,
        );
      }

      // Un evento de sandbox no puede mover la contabilidad de producción.
      const expected = row.environment === 'prod' ? 'prod' : 'test';
      if (event.environment && event.environment !== expected) {
        return log(
          {
            outcome: 'wrong_environment',
            detail: `Evento de '${event.environment}' con la pasarela en '${expected}'`,
          },
          true,
        );
      }

      if (!tx.reference) {
        return log(
          {
            outcome: 'unknown_reference',
            detail: 'El evento no trae referencia',
          },
          true,
        );
      }

      const charge = await this.prisma.subscriptionCharge.findUnique({
        where: { reference: tx.reference },
      });
      if (!charge) {
        return log(
          {
            outcome: 'unknown_reference',
            detail: `No hay cobro con la referencia ${tx.reference}`,
          },
          true,
        );
      }

      // El evento solo dice "mira esto". Lo que se cree es el API.
      const confirmed = tx.id ? await this.wompi.getTransaction(tx.id) : null;
      const result = await this.settle(charge, confirmed ?? tx);
      return log(result, true);
    } catch (err) {
      const detail = (err as Error).message;
      this.logger.error(`Webhook de Wompi falló: ${detail}`);
      return log({ outcome: 'error', detail }, true);
    }
  }

  async listEvents(limit = 25) {
    const events = await this.prisma.gatewayEvent.findMany({
      orderBy: { receivedAt: 'desc' },
      take: Math.min(limit, 100),
    });
    return { events };
  }

  // ─── Conciliación ───────────────────────────────────────────────────────────

  /**
   * Convierte una transacción aprobada en un pago real. Idempotente por dos
   * vías: el claim atómico sobre `providerTxId` y el único de esa columna.
   */
  private async settle(
    charge: SubscriptionCharge,
    tx: WompiTransactionView,
  ): Promise<SettleResult> {
    if (charge.status === 'paid') {
      return {
        outcome: 'duplicate',
        detail: 'El cobro ya estaba conciliado',
        chargeId: charge.id,
      };
    }

    if (tx.status !== 'APPROVED') {
      const failed = ['DECLINED', 'ERROR', 'VOIDED'].includes(tx.status ?? '');
      await this.prisma.subscriptionCharge.update({
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

    // Que la transacción esté aprobada no significa que sea por lo que se pidió.
    const expectedCents = copToCents(charge.amount);
    if (tx.amountInCents !== null && tx.amountInCents !== expectedCents) {
      await this.prisma.subscriptionCharge.update({
        where: { id: charge.id },
        data: {
          statusDetail: `Monto distinto: Wompi cobró ${tx.amountInCents / 100} y el cobro era ${charge.amount}`,
          providerTxId: charge.providerTxId ?? tx.id,
        },
      });
      return {
        outcome: 'amount_mismatch',
        detail: 'El monto aprobado no coincide con el del cobro',
        chargeId: charge.id,
      };
    }

    // Claim atómico: el primero que escriba `providerTxId` se queda el cobro.
    // Dos webhooks simultáneos (Wompi reintenta) no pueden pagar dos veces.
    if (!charge.providerTxId && tx.id) {
      const claimed = await this.prisma.subscriptionCharge.updateMany({
        where: { id: charge.id, providerTxId: null },
        data: { providerTxId: tx.id },
      });
      if (claimed.count === 0) {
        return {
          outcome: 'duplicate',
          detail: 'Otro aviso tomó este cobro primero',
          chargeId: charge.id,
        };
      }
    }

    const paidAt = tx.finalizedAt ? new Date(tx.finalizedAt) : new Date();
    const fee = await this.gatewayFee(charge.amount);

    const payment = await this.platform.createPayment(
      charge.tenantId,
      {
        amount: charge.amount,
        officialPrice: charge.listAmount ?? charge.amount,
        discountApplied: charge.discountAmount,
        discountReason: charge.discountReason ?? undefined,
        currency: 'COP',
        periodStart: calendarDayCO(charge.periodStart),
        periodEnd: calendarDayCO(charge.periodEnd),
        paidAt: paidAt.toISOString(),
        method: 'card',
        reference: tx.id ?? charge.reference,
        note: `Cobro ${charge.reference} · ${tx.paymentMethodType ?? 'pasarela'}`,
        extendPeriod: true,
      },
      WEBHOOK_ACTOR,
    );

    await this.prisma.subscriptionCharge.update({
      where: { id: charge.id },
      data: {
        status: 'paid',
        statusDetail: null,
        paidAt,
        paymentMethodType: tx.paymentMethodType,
        gatewayFee: fee,
        netSettled: charge.amount - fee,
        paymentId: payment.id,
      },
    });

    // La comisión NO es un descuento: es plata que salió. Sin este gasto la
    // utilidad del backoffice queda inflada ~3,5%. Ver §4 del plan.
    if (fee > 0) {
      await this.prisma.platformExpense.create({
        data: {
          category: 'fees',
          concept: `Comisión pasarela · ${charge.reference}`,
          vendor: 'Wompi',
          amount: fee,
          currency: 'COP',
          kind: 'one_time',
          incurredAt: paidAt,
          note: `Transacción ${tx.id ?? 's/n'} · ${tx.paymentMethodType ?? ''}`.trim(),
          createdByUserId: WEBHOOK_ACTOR,
        },
      });
    }

    return {
      outcome: 'paid',
      detail: `Pago registrado por ${charge.amount} COP`,
      chargeId: charge.id,
    };
  }

  /** Comisión con la tarifa configurada: (monto × % + fijo) × (1 + IVA). */
  private async gatewayFee(amountCOP: number): Promise<number> {
    const row = await this.settings.get();
    const base = (amountCOP * row.feePercentBps) / 10_000 + row.feeFixedCOP;
    return Math.round(base * (1 + row.feeTaxBps / 10_000));
  }

  private async loadCharge(id: string): Promise<SubscriptionCharge> {
    const charge = await this.prisma.subscriptionCharge.findUnique({
      where: { id },
    });
    if (!charge) throw new NotFoundException(`Cobro ${id} no existe`);
    return charge;
  }
}
