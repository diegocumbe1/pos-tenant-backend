import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  addCalendarDaysCO,
  calendarDayCO,
  formatCOP,
} from '../../common/date.util';

type Tx = Prisma.TransactionClient;

/**
 * Financiación en el punto de venta (Sistecrédito, Addi).
 *
 * Vive en `shared` y no dentro del módulo porque lo usan dos dueños distintos:
 * el módulo de convenios (que los configura y concilia los giros) y el de
 * ventas (que congela los términos al cobrar). Importar el servicio de uno
 * desde el otro haría un ciclo.
 *
 * Plan completo: docs/PLAN_PAGOS_FINANCIACION_SISTECREDITO_ADDI.md.
 */

/** Origen de un gasto escrito por el sistema. Ver `Expense.sourceType`. */
export const EXPENSE_SOURCE = {
  sale: 'RETAIL_SALE',
  shipment: 'RETAIL_SHIPMENT',
  settlement: 'FINANCING_SETTLEMENT',
} as const;

/** Términos congelados que viajan en la venta y en el abono. */
export interface FrozenFinancingTerms {
  financingProviderId: string;
  financingProviderName: string;
  financingFeeBps: number;
  financingFeeCOP: number;
}

/**
 * Los términos que regían en una fecha.
 *
 * Pregunta por la fila con el `effectiveFrom` más reciente que no sea futuro,
 * igual que el cobro de plataforma le pregunta a `plan_prices` la tarifa de SU
 * fecha. Una venta del 14 de marzo se costea con lo que regía el 14 de marzo,
 * aunque el convenio se haya renegociado en agosto.
 */
export async function termsAt(tx: Tx, providerId: string, at: Date) {
  const term = await tx.financingProviderTerm.findFirst({
    where: { providerId, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!term) {
    // Pasa cuando se configuró el convenio después de la venta que se está
    // digitando. Decirlo así es más útil que un 500: el admin sabe que tiene
    // que poner la fecha efectiva antes.
    throw new BadRequestException(
      'Este convenio no tiene términos vigentes para esa fecha. ' +
        'Revisa desde cuándo rige la comisión en Ajustes → Datos de pago.',
    );
  }
  return term;
}

/**
 * La comisión en pesos.
 *
 * Redondeo al peso, hacia el entero más cercano: la plata colombiana no tiene
 * centavos y arrastrar decimales haría que el neto del giro nunca cuadrara
 * exacto contra lo que reporta el financiador.
 */
export function feeCOP(amountCOP: number, feeBps: number): number {
  return Math.round((amountCOP * feeBps) / 10_000);
}

/** '6,50%' — como se escribe una comisión en pantalla y en el histórico. */
export function formatFeePct(feeBps: number): string {
  return `${(feeBps / 100).toFixed(2).replace('.', ',')}%`;
}

/** Día estimado del giro: la fecha del cobro más los días del convenio. */
export function estimatedSettlementDay(
  paidAt: Date | string,
  settlementDays: number,
): string {
  return addCalendarDaysCO(calendarDayCO(paidAt), settlementDays);
}

/**
 * Resuelve y congela los términos de un cobro con financiación.
 *
 * CONGELAR NO ES REDUNDANCIA. Es el mismo principio del `unitCostCOP` del
 * kardex: si la comisión se leyera del convenio cada vez que se abre una venta
 * vieja, renegociar el convenio reescribiría la utilidad de meses ya cerrados.
 */
export async function freezeTerms(
  tx: Tx,
  params: {
    tenantId: string;
    branchId: string;
    providerId: string;
    amountCOP: number;
    at: Date;
  },
): Promise<FrozenFinancingTerms & { settlementDays: number }> {
  const provider = await tx.financingProvider.findFirst({
    where: {
      id: params.providerId,
      tenantId: params.tenantId,
      branchId: params.branchId,
    },
  });
  if (!provider) {
    throw new BadRequestException('Ese convenio de financiación no existe');
  }
  if (!provider.isActive) {
    throw new BadRequestException(
      `El convenio con ${provider.label} está desactivado`,
    );
  }

  const term = await termsAt(tx, provider.id, params.at);
  if (term.minAmountCOP > 0 && params.amountCOP < term.minAmountCOP) {
    throw new BadRequestException(
      `${provider.label} financia desde ${formatCOP(term.minAmountCOP)} y esta venta es de ${formatCOP(params.amountCOP)}`,
    );
  }

  return {
    financingProviderId: provider.id,
    financingProviderName: provider.label,
    financingFeeBps: term.feeBps,
    financingFeeCOP: feeCOP(params.amountCOP, term.feeBps),
    settlementDays: term.settlementDays,
  };
}

/** Id derivado del gasto de comisión: idempotente, como el del flete. */
export function financingFeeExpenseId(paymentId: string): string {
  return `finfee_${paymentId}`;
}

/** Id derivado del gasto de ajuste de un giro que no llegó completo. */
export function settlementDiffExpenseId(settlementId: string): string {
  return `findiff_${settlementId}`;
}

/**
 * Escribe (o corrige, o borra) el gasto de la comisión de un abono.
 *
 * COPIA FIEL DE `syncShippingExpense`, y por las mismas razones: el id se
 * deriva del abono, así que volver a llamarla actualiza el mismo registro en
 * vez de dejar dos. Si el abono se anula o el gasto deja de tener sentido, se
 * borra: no queda un egreso huérfano que nadie sabe de dónde salió.
 *
 * LA FECHA ES LA DEL GIRO, NO LA DE LA VENTA. La comisión tiene que pesar el
 * mismo día en que se reconoce el ingreso que la causó; si pesara el día de la
 * venta, un mes tendría el gasto y el siguiente el ingreso, y los dos saldrían
 * mal. Mientras el giro no llegue no hay gasto, porque todavía no se sabe si
 * llegó completo.
 */
export async function syncFinancingFeeExpense(tx: Tx, paymentId: string) {
  const payment = await tx.retailSalePayment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      tenantId: true,
      branchId: true,
      method: true,
      amountCOP: true,
      voidedAt: true,
      settledAt: true,
      financingFeeBps: true,
      financingFeeCOP: true,
      financingProviderName: true,
      saleId: true,
      sale: { select: { code: true, status: true } },
    },
  });

  const id = financingFeeExpenseId(paymentId);
  const fee = payment?.financingFeeCOP ?? 0;
  const applies =
    !!payment &&
    payment.method === 'FINANCING' &&
    !payment.voidedAt &&
    payment.sale?.status !== 'VOIDED' &&
    !!payment.settledAt &&
    fee > 0;

  if (!applies) {
    await tx.expense.deleteMany({ where: { id } });
    return;
  }

  const data = {
    tenantId: payment.tenantId,
    branchId: payment.branchId,
    category: 'FINANCING_FEE',
    concept:
      `Comisión ${payment.financingProviderName ?? 'financiación'} · venta ${payment.sale?.code ?? ''}`.trim(),
    amountCOP: fee,
    incurredAt: payment.settledAt as Date,
    // El desglose va en la nota porque el monto solo no explica nada: sin esto,
    // el dueño ve un egreso de $78.000 y no sabe de dónde salió el número.
    note:
      `${formatFeePct(payment.financingFeeBps ?? 0)} sobre ${formatCOP(payment.amountCOP)}` +
      ' · la comisión la fija el convenio, no Lynko',
    sourceType: EXPENSE_SOURCE.sale,
    sourceId: payment.saleId,
  };

  await tx.expense.upsert({
    where: { id },
    create: { id, ...data },
    update: data,
  });
}
