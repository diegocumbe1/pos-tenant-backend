import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Validación del checksum de los eventos de Wompi. Puro y probado aparte: es lo
 * único que separa "me avisaron de un pago" de "cualquiera puede decir que le
 * pagaron". Spec: docs.wompi.co → Guías → Eventos.
 */

export interface WompiEvent {
  event?: string;
  data?: Record<string, unknown>;
  environment?: string;
  signature?: { properties?: string[]; checksum?: string };
  timestamp?: number;
  sent_at?: string;
}

export interface WompiTransactionView {
  id: string | null;
  reference: string | null;
  status: string | null;
  amountInCents: number | null;
  paymentMethodType: string | null;
  finalizedAt: string | null;
  customerEmail: string | null;
}

/**
 * SHA256 de: los valores de `signature.properties` concatenados EN ORDEN, más
 * el `timestamp`, más el secreto de eventos. Las rutas son relativas a `data`
 * (p.ej. "transaction.id" → data.transaction.id).
 */
export function eventChecksum(
  event: WompiEvent,
  eventsSecret: string,
): string | null {
  const properties = event.signature?.properties;
  if (!Array.isArray(properties) || properties.length === 0) return null;
  if (event.timestamp === undefined || event.timestamp === null) return null;

  const parts: string[] = [];
  for (const path of properties) {
    const value = readPath(event.data, path);
    // Una propiedad ausente —o un objeto, que no se puede concatenar— haría una
    // firma distinta a la de Wompi y el evento se rechazaría por la razón
    // equivocada: mejor decir que no se puede validar.
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      return null;
    }
    parts.push(String(value));
  }

  const payload = `${parts.join('')}${String(event.timestamp)}${eventsSecret}`;
  return createHash('sha256').update(payload).digest('hex');
}

/** Comparación en tiempo constante: el checksum es un secreto derivado. */
export function checksumMatches(
  event: WompiEvent,
  eventsSecret: string,
): boolean {
  const expected = eventChecksum(event, eventsSecret);
  const received = event.signature?.checksum;
  if (!expected || !received || expected.length !== received.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

/** Lee "a.b.c" dentro de un objeto sin explotar si falta un tramo. */
export function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in acc) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

/** Aplana la transacción del evento (o de `GET /transactions/:id`). */
export function readTransaction(source: unknown): WompiTransactionView {
  const tx =
    (readPath(source, 'transaction') as Record<string, unknown>) ??
    (source as Record<string, unknown>) ??
    {};

  const str = (key: string): string | null => {
    const value = tx[key];
    return typeof value === 'string' ? value : null;
  };

  const amount = tx['amount_in_cents'];

  return {
    id: str('id'),
    reference: str('reference'),
    status: str('status'),
    amountInCents: typeof amount === 'number' ? amount : null,
    paymentMethodType: str('payment_method_type'),
    finalizedAt: str('finalized_at') ?? str('created_at'),
    customerEmail: str('customer_email'),
  };
}
