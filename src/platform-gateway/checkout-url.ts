import { createHash } from 'node:crypto';

/**
 * Construcción del link de Checkout Web de Wompi. Puro y sin dependencias para
 * poder probarlo: la firma de integridad es lo único que impide que alguien
 * edite el monto en la URL, así que conviene tenerla cubierta.
 *
 * Spec: docs.wompi.co → Guías → Widget & Checkout Web.
 */

/**
 * El host del checkout es el mismo para sandbox y producción: el ambiente lo
 * determina la llave pública, no la URL. (Lo contrario del API, donde sí hay
 * dos hosts distintos.)
 */
export const WOMPI_CHECKOUT_URL = 'https://checkout.wompi.co/p/';

/** Único soportado por Wompi hoy. */
export const CHECKOUT_CURRENCY = 'COP';

export interface CheckoutCustomer {
  email?: string | null;
  fullName?: string | null;
  /** Sin indicativo; va aparte en `phonePrefix`. */
  phoneNumber?: string | null;
  phonePrefix?: string | null;
  legalId?: string | null;
  /** 'CC' | 'NIT' | … */
  legalIdType?: string | null;
}

export interface CheckoutInput {
  publicKey: string;
  integritySecret: string;
  /** Nuestra referencia. Es la que vuelve en el webhook y concilia el cobro. */
  reference: string;
  /** COP × 100. Wompi trabaja en centavos aunque el peso no los use. */
  amountInCents: number;
  redirectUrl?: string | null;
  /** Si viene, entra en la firma y el checkout muestra cuenta regresiva. */
  expiresAt?: Date | null;
  customer?: CheckoutCustomer;
}

export interface BuiltCheckout {
  url: string;
  reference: string;
  amountInCents: number;
  currency: string;
  signature: string;
  expirationTime: string | null;
}

/**
 * SHA256 de la concatenación EN ESTE ORDEN:
 *   referencia + montoEnCentavos + moneda [+ fechaExpiración] + secretoIntegridad
 *
 * La fecha solo entra si se manda `expiration-time` en el link, y tiene que ser
 * exactamente el mismo string que viaja en la URL: si se firma un ISO y se
 * manda otro, Wompi rechaza el checkout.
 */
export function integritySignature(params: {
  reference: string;
  amountInCents: number;
  currency: string;
  integritySecret: string;
  expirationTime?: string | null;
}): string {
  const { reference, amountInCents, currency, integritySecret } = params;
  const expiration = params.expirationTime ?? '';
  const payload = `${reference}${amountInCents}${currency}${expiration}${integritySecret}`;
  return createHash('sha256').update(payload).digest('hex');
}

/** Referencia propia del cobro. Wompi acepta alfanumérico con `-` y `_`. */
export function buildReference(parts: {
  tenantSlug: string;
  period: string;
  nonce: string;
}): string {
  const slug = parts.tenantSlug.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  return `LYNKO-${slug}-${parts.period}-${parts.nonce}`;
}

export function buildCheckoutUrl(input: CheckoutInput): BuiltCheckout {
  if (!Number.isInteger(input.amountInCents) || input.amountInCents <= 0) {
    throw new Error('El monto del checkout debe ser un entero de centavos > 0');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(input.reference)) {
    throw new Error('La referencia solo admite alfanuméricos, `-` y `_`');
  }

  const expirationTime = input.expiresAt ? input.expiresAt.toISOString() : null;

  const signature = integritySignature({
    reference: input.reference,
    amountInCents: input.amountInCents,
    currency: CHECKOUT_CURRENCY,
    integritySecret: input.integritySecret,
    expirationTime,
  });

  const query = new URLSearchParams({
    'public-key': input.publicKey,
    currency: CHECKOUT_CURRENCY,
    'amount-in-cents': String(input.amountInCents),
    reference: input.reference,
    'signature:integrity': signature,
  });

  if (input.redirectUrl) query.set('redirect-url', input.redirectUrl);
  if (expirationTime) query.set('expiration-time', expirationTime);

  const c = input.customer;
  if (c?.email) query.set('customer-data:email', c.email);
  if (c?.fullName) query.set('customer-data:full-name', c.fullName);
  if (c?.phoneNumber) query.set('customer-data:phone-number', c.phoneNumber);
  if (c?.phonePrefix) {
    query.set('customer-data:phone-number-prefix', c.phonePrefix);
  }
  if (c?.legalId) query.set('customer-data:legal-id', c.legalId);
  if (c?.legalIdType) query.set('customer-data:legal-id-type', c.legalIdType);

  return {
    url: `${WOMPI_CHECKOUT_URL}?${query.toString()}`,
    reference: input.reference,
    amountInCents: input.amountInCents,
    currency: CHECKOUT_CURRENCY,
    signature,
    expirationTime,
  };
}

/** COP → centavos. El peso no tiene decimales, pero el API sí los pide. */
export function copToCents(amountCOP: number): number {
  return Math.round(amountCOP) * 100;
}
