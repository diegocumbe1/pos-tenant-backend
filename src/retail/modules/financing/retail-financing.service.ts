import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  calendarDayCO,
  dayStartCO,
  formatCOP,
} from '../../../common/date.util';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import {
  EXPENSE_SOURCE,
  estimatedSettlementDay,
  feeCOP,
  formatFeePct,
  settlementDiffExpenseId,
  syncFinancingFeeExpense,
} from '../../shared/retail-financing';
import {
  CreateFinancingProviderDto,
  CreateFinancingSettlementDto,
  FinancingTermsDto,
  ResolveFinancingStatusDto,
  UpdateFinancingProviderDto,
} from './dto/financing.dto';

type Tx = Prisma.TransactionClient;

/**
 * Convenios de financiación y sus giros.
 *
 * Lo que este módulo NO hace, y es deliberado: no guarda un solo dato de la
 * solicitud de crédito del cliente —ni cédula, ni ingresos, ni cuotas, ni
 * tasa—. Solo el código de autorización que devuelve la app del financiador.
 * Guardar lo demás nos metería en el alcance de la Ley 1581 sin ninguna
 * ganancia operativa: al comercio le giran lo mismo sean 3 cuotas o 12.
 */
@Injectable()
export class RetailFinancingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
  ) {}

  private readonly txOptions = { timeout: 20_000 };

  // ─── Convenios ─────────────────────────────────────────────────────────────

  /**
   * Los convenios de la sede, cada uno con los términos que rigen HOY y con su
   * historial completo.
   *
   * El historial viaja siempre porque es la respuesta a "¿por qué esta venta de
   * marzo dice 6,5% si ahora pago 4%?", y esa pregunta se hace mirando la
   * pantalla de ajustes, no un reporte aparte.
   */
  async listProviders(
    ctx: TenantContext,
    opts: { includeInactive?: boolean } = {},
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);

    const providers = await this.prisma.financingProvider.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        ...(opts.includeInactive ? {} : { isActive: true }),
      },
      include: { terms: { orderBy: { effectiveFrom: 'desc' } } },
      orderBy: [{ isActive: 'desc' }, { label: 'asc' }],
    });

    const now = new Date();
    return providers.map((provider) => this.toProviderDto(provider, now));
  }

  async createProvider(ctx: TenantContext, dto: CreateFinancingProviderDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);

    const clash = await this.prisma.financingProvider.findFirst({
      where: { branchId: ctx.branchId, code: dto.code },
      select: { id: true, label: true },
    });
    if (clash) {
      throw new BadRequestException(
        `Ya tienes un convenio con el código "${dto.code}" (${clash.label})`,
      );
    }

    const provider = await this.prisma.$transaction(async (tx) => {
      const created = await tx.financingProvider.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          code: dto.code,
          label: dto.label,
          note: dto.note,
        },
      });
      await this.appendTerms(tx, created.id, ctx, dto, 'alta del convenio');
      return created;
    }, this.txOptions);

    return this.getProvider(ctx, provider.id);
  }

  async updateProvider(
    ctx: TenantContext,
    id: string,
    dto: UpdateFinancingProviderDto,
  ) {
    await this.assertProvider(ctx, id);
    await this.prisma.financingProvider.update({
      where: { id },
      data: { label: dto.label, isActive: dto.isActive, note: dto.note },
    });
    return this.getProvider(ctx, id);
  }

  /**
   * Nuevos términos para un convenio.
   *
   * APPEND-ONLY: nunca edita la fila anterior. Los dos motivos por los que un
   * admin toca esta pantalla se resuelven distinto, y por eso `recalculate`
   * existe:
   *
   *   • RENEGOCIACIÓN (`recalculate` en false, el caso normal) → la fila nueva
   *     rige desde su fecha y el pasado NO se toca. Las ventas de marzo siguen
   *     al 6,5% porque eso fue lo que costaron.
   *
   *   • CORRECCIÓN DE DIGITACIÓN (`recalculate` en true) → se escribió 6,5%
   *     cuando el contrato siempre dijo 4,5%. Ahí el pasado sí está mal y hay
   *     que recalcular la comisión congelada y su gasto.
   *
   * Que sea explícito es el punto. Editar un porcentaje y que cambie en
   * silencio la utilidad de meses ya cerrados es exactamente lo que hace que un
   * dueño deje de confiar en los números.
   */
  async setTerms(ctx: TenantContext, id: string, dto: FinancingTermsDto) {
    const provider = await this.assertProvider(ctx, id);

    const result = await this.prisma.$transaction(async (tx) => {
      const term = await this.appendTerms(tx, id, ctx, dto, dto.reason);
      if (!dto.recalculate) return { term, recalculated: 0 };

      const recalculated = await this.recalculateFrom(
        tx,
        ctx,
        provider.id,
        term.effectiveFrom,
        term.feeBps,
      );
      return { term, recalculated };
    }, this.txOptions);

    return {
      ...(await this.getProvider(ctx, id)),
      /** Cuántas ventas quedaron recalculadas. 0 en una renegociación normal. */
      recalculatedSales: result.recalculated,
    };
  }

  async getProvider(ctx: TenantContext, id: string) {
    const provider = await this.prisma.financingProvider.findFirstOrThrow({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: { terms: { orderBy: { effectiveFrom: 'desc' } } },
    });
    return this.toProviderDto(provider, new Date());
  }

  // ─── Bandeja "por desembolsar" ─────────────────────────────────────────────

  /**
   * Lo que los financiadores todavía deben.
   *
   * Son abonos con `settledAt` en NULL: plata reconocida como venta pero que no
   * ha entrado a ninguna cuenta. Es la pregunta "¿cuánto me debe Addi?", que
   * hoy no se puede responder en ninguna parte.
   */
  async listPending(ctx: TenantContext, opts: { providerId?: string } = {}) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);

    const payments = await this.prisma.retailSalePayment.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        method: 'FINANCING',
        voidedAt: null,
        settledAt: null,
        ...(opts.providerId ? { financingProviderId: opts.providerId } : {}),
        sale: { status: 'COMPLETED' },
      },
      include: {
        sale: {
          select: { id: true, code: true, soldAt: true, totalCOP: true },
        },
      },
      orderBy: { paidAt: 'asc' },
    });

    const terms = await this.prisma.financingProviderTerm.findMany({
      where: { provider: { tenantId: ctx.tenantId, branchId: ctx.branchId } },
      orderBy: { effectiveFrom: 'desc' },
    });
    const daysByProvider = new Map<string, number>();
    for (const term of terms) {
      if (!daysByProvider.has(term.providerId)) {
        daysByProvider.set(term.providerId, term.settlementDays);
      }
    }

    const items = payments.map((payment) => {
      const days = daysByProvider.get(payment.financingProviderId ?? '') ?? 0;
      return {
        paymentId: payment.id,
        saleId: payment.saleId,
        saleCode: payment.sale.code,
        soldAt: payment.sale.soldAt.toISOString(),
        paidAt: payment.paidAt.toISOString(),
        providerId: payment.financingProviderId,
        providerName: payment.financingProviderName,
        authCode: payment.financingAuthCode,
        amountCOP: payment.amountCOP,
        feeBps: payment.financingFeeBps ?? 0,
        feeCOP: payment.financingFeeCOP ?? 0,
        /** Lo que debería llegar por esta venta. */
        netCOP: payment.amountCOP - (payment.financingFeeCOP ?? 0),
        /** Día estimado del giro, según el convenio vigente. */
        estimatedSettlementDay: estimatedSettlementDay(payment.paidAt, days),
      };
    });

    // Agrupado por proveedor: la pregunta nunca es por una venta suelta, es
    // "¿cuánto me debe Addi?". El detalle viaja igual para poder abrir cada una.
    const byProvider = new Map<
      string,
      {
        providerId: string;
        providerName: string;
        salesCount: number;
        grossCOP: number;
        feeCOP: number;
        netCOP: number;
      }
    >();
    for (const item of items) {
      const key = item.providerId ?? 'sin-convenio';
      const bucket = byProvider.get(key) ?? {
        providerId: key,
        providerName: item.providerName ?? 'Sin convenio',
        salesCount: 0,
        grossCOP: 0,
        feeCOP: 0,
        netCOP: 0,
      };
      bucket.salesCount += 1;
      bucket.grossCOP += item.amountCOP;
      bucket.feeCOP += item.feeCOP;
      bucket.netCOP += item.netCOP;
      byProvider.set(key, bucket);
    }

    return {
      items,
      byProvider: [...byProvider.values()].sort((a, b) => b.netCOP - a.netCOP),
      totals: {
        salesCount: items.length,
        grossCOP: items.reduce((sum, item) => sum + item.amountCOP, 0),
        feeCOP: items.reduce((sum, item) => sum + item.feeCOP, 0),
        netCOP: items.reduce((sum, item) => sum + item.netCOP, 0),
      },
    };
  }

  // ─── Giros ─────────────────────────────────────────────────────────────────

  async listSettlements(
    ctx: TenantContext,
    opts: { from?: string; to?: string; providerId?: string } = {},
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);

    const settlements = await this.prisma.financingSettlement.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        ...(opts.providerId ? { providerId: opts.providerId } : {}),
        ...(opts.from || opts.to
          ? {
              settledAt: {
                ...(opts.from ? { gte: dayStartCO(opts.from) } : {}),
                ...(opts.to
                  ? { lte: new Date(`${opts.to}T23:59:59.999Z`) }
                  : {}),
              },
            }
          : {}),
      },
      include: {
        provider: { select: { label: true } },
        payments: {
          select: {
            id: true,
            amountCOP: true,
            financingFeeCOP: true,
            saleId: true,
            sale: { select: { code: true } },
          },
        },
      },
      orderBy: { settledAt: 'desc' },
    });

    return settlements.map((settlement) => ({
      id: settlement.id,
      providerId: settlement.providerId,
      providerName: settlement.provider.label,
      settledAt: settlement.settledAt.toISOString(),
      expectedCOP: settlement.expectedCOP,
      receivedCOP: settlement.receivedCOP,
      /** Negativo = llegó menos de lo esperado. Es el caso de reclamación. */
      differenceCOP: settlement.receivedCOP - settlement.expectedCOP,
      reference: settlement.reference,
      note: settlement.note,
      salesCount: settlement.payments.length,
      sales: settlement.payments.map((payment) => ({
        paymentId: payment.id,
        saleId: payment.saleId,
        saleCode: payment.sale.code,
        amountCOP: payment.amountCOP,
        feeCOP: payment.financingFeeCOP ?? 0,
        netCOP: payment.amountCOP - (payment.financingFeeCOP ?? 0),
      })),
    }));
  }

  /**
   * Registra un giro que ya llegó al banco.
   *
   * ES EL MOMENTO EN QUE LA PLATA ENTRA. Hasta acá la venta estaba contada como
   * venta pero no como ingreso; al sellar `settledAt` en cada abono, esa plata
   * pasa a pesar en el día del giro (ver `settledAtRange` en ventas). La
   * comisión se vuelve gasto el mismo día, por la misma razón.
   *
   * LA DIFERENCIA NO SE ESCONDE. Si llegaron $4.280.000 donde se esperaban
   * $4.300.000, los $20.000 quedan como gasto de ajuste atado a este giro. Es
   * el caso más común de reclamación al proveedor y hoy nadie lo detecta.
   */
  async createSettlement(
    ctx: TenantContext,
    dto: CreateFinancingSettlementDto,
  ) {
    await this.assertProvider(ctx, dto.providerId);
    if (dto.paymentIds.length === 0) {
      throw new BadRequestException('Elige al menos una venta para el giro');
    }

    const settledAt = dto.settledAt ? dayStartCO(dto.settledAt) : new Date();

    const id = await this.prisma.$transaction(async (tx) => {
      const payments = await tx.retailSalePayment.findMany({
        where: {
          id: { in: dto.paymentIds },
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          method: 'FINANCING',
          voidedAt: null,
        },
        select: {
          id: true,
          amountCOP: true,
          financingFeeCOP: true,
          financingProviderId: true,
          settledAt: true,
        },
      });

      if (payments.length !== dto.paymentIds.length) {
        throw new BadRequestException(
          'Hay ventas que ya no existen o que no son de financiación',
        );
      }
      const already = payments.filter((payment) => payment.settledAt);
      if (already.length > 0) {
        throw new BadRequestException(
          `${already.length} de esas ventas ya estaban desembolsadas`,
        );
      }
      const foreign = payments.filter(
        (payment) => payment.financingProviderId !== dto.providerId,
      );
      if (foreign.length > 0) {
        // Mezclar convenios en un giro haría que la comisión de uno se le
        // cargara al otro, y el reporte por proveedor dejaría de servir.
        throw new BadRequestException(
          'Todas las ventas del giro tienen que ser del mismo financiador',
        );
      }

      const expectedCOP = payments.reduce(
        (sum, payment) =>
          sum + payment.amountCOP - (payment.financingFeeCOP ?? 0),
        0,
      );

      const settlement = await tx.financingSettlement.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          providerId: dto.providerId,
          expectedCOP,
          receivedCOP: dto.receivedCOP,
          settledAt,
          reference: dto.reference,
          note: dto.note,
          createdBy: ctx.userId,
        },
      });

      await tx.retailSalePayment.updateMany({
        where: { id: { in: payments.map((payment) => payment.id) } },
        data: { settledAt, financingSettlementId: settlement.id },
      });

      const saleIds = await tx.retailSalePayment.findMany({
        where: { financingSettlementId: settlement.id },
        select: { id: true, saleId: true },
      });
      for (const payment of saleIds) {
        await syncFinancingFeeExpense(tx, payment.id);
      }
      await tx.retailSale.updateMany({
        where: { id: { in: saleIds.map((row) => row.saleId) } },
        data: { financingStatus: 'SETTLED' },
      });

      await this.syncSettlementDifference(tx, settlement.id);
      return settlement.id;
    }, this.txOptions);

    const settlements = await this.listSettlements(ctx, {});
    return settlements.find((row) => row.id === id);
  }

  // ─── Respuesta del financiador ─────────────────────────────────────────────

  /**
   * Resuelve una venta que quedó en `PENDING_APPROVAL`.
   *
   * APPROVED es un cambio de estado y ya: la venta siempre estuvo bien.
   *
   * RECHAZADA ES LO INTERESANTE. La venta se cerró como cobrada porque se
   * asumió que el financiador respondía por ella; si dijo que no, esa plata NO
   * va a entrar nunca. Anular el abono devuelve la venta a "por cobrar", que es
   * la verdad: el cliente se llevó la mercancía y todavía debe. Dejarla cobrada
   * infla el ingreso con plata que no existe, y borrar el abono escondería que
   * se intentó financiar.
   *
   * El stock NO se toca: la mercancía salió y sigue afuera. Si el cliente la
   * devuelve, eso es una devolución, no un rechazo de crédito.
   */
  async resolveStatus(
    ctx: TenantContext,
    saleId: string,
    dto: ResolveFinancingStatusDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'retailSale',
      ctx,
      saleId,
      'Sale',
    );

    const sale = await this.prisma.retailSale.findUniqueOrThrow({
      where: { id: saleId },
      select: {
        id: true,
        code: true,
        status: true,
        financingStatus: true,
        financingProviderName: true,
      },
    });
    if (sale.status === 'VOIDED') {
      throw new BadRequestException('La venta está anulada');
    }
    if (sale.financingStatus !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        'Esta venta no está esperando respuesta del financiador',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.retailSale.update({
        where: { id: saleId },
        data: { financingStatus: dto.status },
      });

      const provider = sale.financingProviderName ?? 'El financiador';

      if (dto.status === 'REJECTED') {
        const payments = await tx.retailSalePayment.findMany({
          where: {
            saleId,
            method: 'FINANCING',
            voidedAt: null,
            settledAt: null,
          },
          select: { id: true, amountCOP: true },
        });

        for (const payment of payments) {
          await tx.retailSalePayment.update({
            where: { id: payment.id },
            data: {
              voidedAt: new Date(),
              voidedReason: dto.reason
                ? `Crédito rechazado: ${dto.reason}`
                : 'Crédito rechazado por el financiador',
              voidedBy: ctx.userId,
            },
          });
          await syncFinancingFeeExpense(tx, payment.id);
        }

        // Recalcula `paidCOP` y devuelve la venta a PENDING / PARTIAL según lo
        // que quede en pie. Es el mismo camino que usa anular un abono.
        await this.syncSalePaymentFromFinancing(tx, saleId);
      }

      await tx.retailSaleEvent.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          saleId,
          kind: dto.status === 'REJECTED' ? 'PAYMENT_VOIDED' : 'NOTE',
          summary:
            dto.status === 'APPROVED'
              ? `${provider} aprobó el crédito`
              : `${provider} RECHAZÓ el crédito: la venta vuelve a "por cobrar"`,
          note: dto.reason,
          userId: ctx.userId,
          userName: ctx.name,
        },
      });
    }, this.txOptions);

    return { ok: true };
  }

  /**
   * Recalcula lo abonado de una venta tras anular sus cobros de financiación.
   *
   * Duplica a propósito lo mínimo de `syncSalePayment` del servicio de ventas:
   * importarlo haría un ciclo entre los dos módulos, y lo que hace falta acá es
   * solo el recálculo, no el resto de su lógica.
   */
  private async syncSalePaymentFromFinancing(tx: Tx, saleId: string) {
    const sale = await tx.retailSale.findUniqueOrThrow({
      where: { id: saleId },
      select: { totalCOP: true },
    });
    const aggregate = await tx.retailSalePayment.aggregate({
      where: { saleId, voidedAt: null },
      _sum: { amountCOP: true },
    });
    const paidCOP = aggregate._sum.amountCOP ?? 0;

    await tx.retailSale.update({
      where: { id: saleId },
      data: {
        paidCOP,
        paymentStatus:
          paidCOP >= sale.totalCOP
            ? 'PAID'
            : paidCOP > 0
              ? 'PARTIAL'
              : 'PENDING',
        paidAt: paidCOP >= sale.totalCOP ? new Date() : null,
      },
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async assertProvider(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const provider = await this.prisma.financingProvider.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
    if (!provider) {
      throw new BadRequestException('Ese convenio de financiación no existe');
    }
    return provider;
  }

  private async appendTerms(
    tx: Tx,
    providerId: string,
    ctx: TenantContext,
    dto: FinancingTermsDto,
    reason?: string,
  ) {
    return tx.financingProviderTerm.create({
      data: {
        providerId,
        feeBps: dto.feeBps,
        settlementDays: dto.settlementDays,
        minAmountCOP: dto.minAmountCOP ?? 0,
        feeHasVat: dto.feeHasVat ?? true,
        effectiveFrom: dto.effectiveFrom
          ? dayStartCO(dto.effectiveFrom)
          : new Date(),
        reason: dto.reason ?? reason,
        createdBy: ctx.userId,
      },
    });
  }

  /**
   * Recalcula la comisión congelada de lo ya vendido. Solo para corregir un
   * error de digitación: nunca se llama en una renegociación.
   */
  private async recalculateFrom(
    tx: Tx,
    ctx: TenantContext,
    providerId: string,
    from: Date,
    feeBps: number,
  ) {
    const payments = await tx.retailSalePayment.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        method: 'FINANCING',
        financingProviderId: providerId,
        voidedAt: null,
        paidAt: { gte: from },
      },
      select: { id: true, amountCOP: true, saleId: true },
    });

    for (const payment of payments) {
      await tx.retailSalePayment.update({
        where: { id: payment.id },
        data: {
          financingFeeBps: feeBps,
          financingFeeCOP: feeCOP(payment.amountCOP, feeBps),
        },
      });
      await syncFinancingFeeExpense(tx, payment.id);
    }

    const saleIds = [...new Set(payments.map((payment) => payment.saleId))];
    for (const saleId of saleIds) {
      const sale = await tx.retailSale.findUniqueOrThrow({
        where: { id: saleId },
        select: { totalCOP: true },
      });
      await tx.retailSale.update({
        where: { id: saleId },
        data: {
          financingFeeBps: feeBps,
          financingFeeCOP: feeCOP(sale.totalCOP, feeBps),
        },
      });
    }

    return saleIds.length;
  }

  /**
   * El gasto (o el menor gasto) por lo que el giro no cuadró.
   *
   * Puede ser NEGATIVO cuando llega de más, y eso es correcto: significa que la
   * comisión real fue menor a la congelada, así que la categoría del mes tiene
   * que bajar. Un ajuste que solo supiera restar dejaría plata sin explicar.
   */
  private async syncSettlementDifference(tx: Tx, settlementId: string) {
    const settlement = await tx.financingSettlement.findUniqueOrThrow({
      where: { id: settlementId },
      include: { provider: { select: { label: true } } },
    });

    const id = settlementDiffExpenseId(settlementId);
    const difference = settlement.expectedCOP - settlement.receivedCOP;
    if (difference === 0) {
      await tx.expense.deleteMany({ where: { id } });
      return;
    }

    const data = {
      tenantId: settlement.tenantId,
      branchId: settlement.branchId,
      category: 'FINANCING_FEE',
      concept: `Ajuste de giro ${settlement.provider.label}${settlement.reference ? ` · ${settlement.reference}` : ''}`,
      amountCOP: difference,
      incurredAt: settlement.settledAt,
      note:
        difference > 0
          ? `Se esperaban ${formatCOP(settlement.expectedCOP)} y llegaron ${formatCOP(settlement.receivedCOP)}: faltaron ${formatCOP(difference)}. Revisar con el financiador.`
          : `Llegaron ${formatCOP(-difference)} más de lo esperado: la comisión real fue menor a la pactada.`,
      sourceType: EXPENSE_SOURCE.settlement,
      sourceId: settlementId,
    };

    await tx.expense.upsert({
      where: { id },
      create: { id, ...data },
      update: data,
    });
  }

  private toProviderDto(
    provider: Prisma.FinancingProviderGetPayload<{
      include: { terms: true };
    }>,
    now: Date,
  ) {
    // Los términos que rigen hoy: la fila más reciente que no sea futura. Una
    // fila con fecha futura ya está guardada pero todavía no cobra.
    const current =
      provider.terms
        .filter((term) => term.effectiveFrom <= now)
        .sort(
          (a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime(),
        )[0] ?? null;

    return {
      id: provider.id,
      code: provider.code,
      label: provider.label,
      isActive: provider.isActive,
      note: provider.note,
      /**
       * `false` mientras no haya términos vigentes. El POS no puede ofrecer un
       * convenio sin comisión: cobraría creyendo que recibe el total.
       */
      isUsable: !!current && provider.isActive,
      feeBps: current?.feeBps ?? null,
      feePct: current ? formatFeePct(current.feeBps) : null,
      settlementDays: current?.settlementDays ?? null,
      minAmountCOP: current?.minAmountCOP ?? 0,
      feeHasVat: current?.feeHasVat ?? true,
      effectiveFrom: current ? calendarDayCO(current.effectiveFrom) : null,
      terms: provider.terms.map((term) => ({
        id: term.id,
        feeBps: term.feeBps,
        feePct: formatFeePct(term.feeBps),
        settlementDays: term.settlementDays,
        minAmountCOP: term.minAmountCOP,
        feeHasVat: term.feeHasVat,
        effectiveFrom: calendarDayCO(term.effectiveFrom),
        reason: term.reason,
        createdAt: term.createdAt.toISOString(),
      })),
    };
  }
}
