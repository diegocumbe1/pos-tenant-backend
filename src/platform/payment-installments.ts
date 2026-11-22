import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/**
 * Plan pagado en cuotas (p. ej. anual en 2 pagos) y enlace público del
 * comprobante. Funciones puras: el servicio solo las llama y persiste.
 */

/** Token del comprobante: 144 bits, base64url (A-Z a-z 0-9 - _). */
export const newReceiptToken = (): string =>
  randomBytes(18).toString('base64url');
export const RECEIPT_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
export const newInstallmentGroupId = (): string =>
  randomBytes(12).toString('hex');

export interface InstallmentInput {
  amount: number;
  number: number;
  total: number;
  planTotal: number;
  planListTotal?: number;
  /** Suma de lo ya pagado en las cuotas anteriores del mismo plan. */
  previousPaid: number;
}

export interface InstallmentSnapshot {
  planTotal: number;
  planListTotal: number;
  balanceAfter: number;
  /** Lo que se espera cobrar en la próxima cuota; null si ya no queda saldo. */
  nextDueAmount: number | null;
}

/**
 * Foto del plan DESPUÉS de esta cuota. El saldo no puede quedar negativo, pero
 * tampoco se disimula un sobrepago: si se pagó de más se rechaza, porque el
 * comprobante le llega al cliente y un "saldo $0" con plata de más confunde.
 */
export function computeInstallment(i: InstallmentInput): InstallmentSnapshot {
  if (i.number > i.total) {
    throw new BadRequestException(
      `La cuota ${i.number} no existe: el plan tiene ${i.total} cuotas.`,
    );
  }
  const paid = i.previousPaid + i.amount;
  if (paid > i.planTotal) {
    throw new BadRequestException(
      `Lo pagado (${paid}) supera el total acordado del plan (${i.planTotal}).`,
    );
  }
  const balanceAfter = i.planTotal - paid;
  const remaining = i.total - i.number;
  let nextDueAmount: number | null = null;
  if (balanceAfter > 0) {
    // La última cuota lleva el residuo; las anteriores se reparten parejo.
    nextDueAmount =
      remaining <= 1 ? balanceAfter : Math.round(balanceAfter / remaining);
  }
  return {
    planTotal: i.planTotal,
    planListTotal: i.planListTotal ?? i.planTotal,
    balanceAfter,
    nextDueAmount,
  };
}
