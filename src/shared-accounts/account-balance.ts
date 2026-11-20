/**
 * Cuenta compartida de una reserva: la cancha (Agenda) y lo que se consumió
 * (Restaurante) se cobran juntas, pero cada abono dice a qué corresponde.
 *
 * Todo aquí es puro (sin base de datos) para que el saldo, el reparto entre
 * personas y la asignación a cada negocio se puedan probar sin montar nada.
 * Reglas:
 *   1. Un abono es siempre de UN concepto (CANCHA o CONSUMO). Quien paga
 *      cancha y consumo a la vez deja dos abonos.
 *   2. Un abono no puede pasar del saldo de su concepto.
 *   3. Los abonos anulados no cuentan.
 *   4. Todo en pesos enteros; el reparto en partes iguales nunca pierde ni
 *      inventa un peso.
 */

export type AccountConcept = 'CANCHA' | 'CONSUMO';

export interface AccountLineInput {
  qty: number;
  priceCOP: number;
}

export interface AccountPaymentInput {
  id?: string;
  payerName?: string | null;
  concept: AccountConcept;
  method: string;
  amountCOP: number;
  voidedAt?: Date | string | null;
}

export interface ConceptBalance {
  totalCOP: number;
  paidCOP: number;
  balanceCOP: number;
}

export interface PayerSummary {
  payerName: string;
  canchaCOP: number;
  consumoCOP: number;
  totalCOP: number;
}

export interface AccountSummary {
  cancha: ConceptBalance;
  consumo: ConceptBalance;
  totalCOP: number;
  paidCOP: number;
  balanceCOP: number;
  /** Quién pagó cuánto y de qué. Sin nombre = "Sin nombre". */
  payers: PayerSummary[];
  /** true cuando no queda saldo en ningún concepto. */
  settled: boolean;
}

export const NO_PAYER = 'Sin nombre';

const isLive = (p: AccountPaymentInput) => !p.voidedAt;

export function consumoTotal(lines: AccountLineInput[]): number {
  return lines.reduce((sum, l) => sum + l.qty * l.priceCOP, 0);
}

function conceptBalance(totalCOP: number, paidCOP: number): ConceptBalance {
  return { totalCOP, paidCOP, balanceCOP: totalCOP - paidCOP };
}

export function summarizeAccount(input: {
  canchaTotalCOP: number;
  lines: AccountLineInput[];
  payments: AccountPaymentInput[];
}): AccountSummary {
  const live = input.payments.filter(isLive);
  const paidBy = (concept: AccountConcept) =>
    live
      .filter((p) => p.concept === concept)
      .reduce((sum, p) => sum + p.amountCOP, 0);

  const cancha = conceptBalance(input.canchaTotalCOP, paidBy('CANCHA'));
  const consumo = conceptBalance(consumoTotal(input.lines), paidBy('CONSUMO'));

  const byPayer = new Map<string, PayerSummary>();
  for (const p of live) {
    const name = p.payerName?.trim() || NO_PAYER;
    const row = byPayer.get(name) ?? {
      payerName: name,
      canchaCOP: 0,
      consumoCOP: 0,
      totalCOP: 0,
    };
    if (p.concept === 'CANCHA') row.canchaCOP += p.amountCOP;
    else row.consumoCOP += p.amountCOP;
    row.totalCOP += p.amountCOP;
    byPayer.set(name, row);
  }

  const totalCOP = cancha.totalCOP + consumo.totalCOP;
  const paidCOP = cancha.paidCOP + consumo.paidCOP;
  return {
    cancha,
    consumo,
    totalCOP,
    paidCOP,
    balanceCOP: totalCOP - paidCOP,
    payers: [...byPayer.values()].sort((a, b) => b.totalCOP - a.totalCOP),
    settled: cancha.balanceCOP <= 0 && consumo.balanceCOP <= 0,
  };
}

/**
 * ¿Se puede registrar este abono? Devuelve el motivo si no.
 * Pasarse del saldo de un concepto es el error más probable: "puse 8.000 de
 * cancha pero ya estaba pagada".
 */
export function checkPayment(
  summary: AccountSummary,
  payment: { concept: AccountConcept; amountCOP: number },
): { ok: true } | { ok: false; reason: string; maxCOP: number } {
  if (!Number.isInteger(payment.amountCOP) || payment.amountCOP < 1) {
    return { ok: false, reason: 'El valor debe ser un entero mayor a 0.', maxCOP: 0 };
  }
  const balance =
    payment.concept === 'CANCHA'
      ? summary.cancha.balanceCOP
      : summary.consumo.balanceCOP;
  const maxCOP = Math.max(0, balance);
  if (payment.amountCOP > maxCOP) {
    const label = payment.concept === 'CANCHA' ? 'la cancha' : 'el consumo';
    return {
      ok: false,
      maxCOP,
      reason:
        maxCOP === 0
          ? `${label[0].toUpperCase()}${label.slice(1)} ya está pagado.`
          : `Solo falta pagar ${maxCOP} de ${label}.`,
    };
  }
  return { ok: true };
}

/**
 * Reparto en partes iguales sin perder pesos: 60.000 entre 8 = 7.500 cada uno;
 * 100.000 entre 3 = 33.334 + 33.333 + 33.333. El sobrante va de a un peso a las
 * primeras partes, así la suma siempre es exacta.
 */
export function splitEqual(totalCOP: number, parts: number): number[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError('Las partes deben ser un entero mayor a 0.');
  }
  const total = Math.max(0, Math.trunc(totalCOP));
  const base = Math.floor(total / parts);
  const extra = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Medios del restaurante: lo único que su pago acepta. */
export type RestaurantPaymentMethod = 'cash' | 'qr' | 'transfer' | 'card';

/**
 * Los medios de Agenda son más finos (Nequi, Daviplata, Bre-B…); el restaurante
 * agrupa en cuatro. Bre-B y QR son un QR; cualquier billetera o cuenta es
 * transferencia. Lo desconocido va a transferencia, que es lo que no mueve el
 * efectivo del cajón.
 */
export function toRestaurantMethod(method: string): RestaurantPaymentMethod {
  const m = method.toUpperCase();
  if (m === 'CASH') return 'cash';
  if (m === 'CARD') return 'card';
  if (m === 'QR' || m === 'BREB') return 'qr';
  return 'transfer';
}

/**
 * Al cerrar: los abonos de CONSUMO agrupados por medio del restaurante, que es
 * como el restaurante registra un pago (un aporte por medio). La suma queda
 * igual a lo abonado.
 */
export function consumoContributions(
  payments: AccountPaymentInput[],
): Array<{ method: RestaurantPaymentMethod; amount: number }> {
  const byMethod = new Map<RestaurantPaymentMethod, number>();
  for (const p of payments.filter(isLive)) {
    if (p.concept !== 'CONSUMO') continue;
    const method = toRestaurantMethod(p.method);
    byMethod.set(method, (byMethod.get(method) ?? 0) + p.amountCOP);
  }
  return [...byMethod.entries()].map(([method, amount]) => ({ method, amount }));
}

/** Los abonos de CANCHA, tal cual, listos para el cobro de Agenda. */
export function canchaPayments(payments: AccountPaymentInput[]) {
  return payments
    .filter((p) => isLive(p) && p.concept === 'CANCHA')
    .map((p) => ({ method: p.method, amountCOP: p.amountCOP }));
}
