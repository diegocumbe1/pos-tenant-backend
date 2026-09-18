import { createHash } from 'node:crypto';
import {
  buildCheckoutUrl,
  buildReference,
  copToCents,
  integritySignature,
} from './checkout-url';

const PUBLIC_KEY = 'pub_test_abc123';
const SECRET = 'test_integrity_s3cr3t';

describe('integritySignature', () => {
  it('concatena referencia + centavos + moneda + secreto', () => {
    const expected = createHash('sha256')
      .update('REF-1490000COP' + SECRET)
      .digest('hex');

    expect(
      integritySignature({
        reference: 'REF-1',
        amountInCents: 490000,
        currency: 'COP',
        integritySecret: SECRET,
      }),
    ).toBe(expected);
  });

  it('mete la expiración ANTES del secreto cuando hay', () => {
    const expiration = '2026-09-30T05:00:00.000Z';
    const expected = createHash('sha256')
      .update('REF-1490000COP' + expiration + SECRET)
      .digest('hex');

    expect(
      integritySignature({
        reference: 'REF-1',
        amountInCents: 490000,
        currency: 'COP',
        integritySecret: SECRET,
        expirationTime: expiration,
      }),
    ).toBe(expected);
  });

  it('cambia si cambia el monto: es lo que impide editarlo en la URL', () => {
    const base = {
      reference: 'REF-1',
      currency: 'COP',
      integritySecret: SECRET,
    };
    expect(integritySignature({ ...base, amountInCents: 490000 })).not.toBe(
      integritySignature({ ...base, amountInCents: 100 }),
    );
  });
});

describe('buildCheckoutUrl', () => {
  const input = {
    publicKey: PUBLIC_KEY,
    integritySecret: SECRET,
    reference: 'LYNKO-barberia-202609-a1b2',
    amountInCents: 7_900_000,
  };

  it('arma la URL con los parámetros que pide Wompi', () => {
    const built = buildCheckoutUrl(input);
    const url = new URL(built.url);

    expect(url.origin + url.pathname).toBe('https://checkout.wompi.co/p/');
    expect(url.searchParams.get('public-key')).toBe(PUBLIC_KEY);
    expect(url.searchParams.get('currency')).toBe('COP');
    expect(url.searchParams.get('amount-in-cents')).toBe('7900000');
    expect(url.searchParams.get('reference')).toBe(input.reference);
    expect(url.searchParams.get('signature:integrity')).toBe(built.signature);
    expect(url.searchParams.get('expiration-time')).toBeNull();
  });

  it('firma el mismo string de expiración que manda en la URL', () => {
    const expiresAt = new Date('2026-09-30T05:00:00.000Z');
    const built = buildCheckoutUrl({ ...input, expiresAt });
    const sent = new URL(built.url).searchParams.get('expiration-time');

    expect(sent).toBe(built.expirationTime);
    expect(built.signature).toBe(
      integritySignature({
        reference: input.reference,
        amountInCents: input.amountInCents,
        currency: 'COP',
        integritySecret: SECRET,
        expirationTime: sent,
      }),
    );
  });

  it('incluye los datos del cliente cuando vienen', () => {
    const built = buildCheckoutUrl({
      ...input,
      redirectUrl: 'https://app.uselynko.com/pago/resultado',
      customer: { email: 'dueno@negocio.co', fullName: 'Ana Ruiz' },
    });
    const params = new URL(built.url).searchParams;

    expect(params.get('customer-data:email')).toBe('dueno@negocio.co');
    expect(params.get('customer-data:full-name')).toBe('Ana Ruiz');
    expect(params.get('redirect-url')).toBe(
      'https://app.uselynko.com/pago/resultado',
    );
  });

  it('rechaza montos y referencias inválidas antes de mandar a nadie a pagar', () => {
    expect(() => buildCheckoutUrl({ ...input, amountInCents: 0 })).toThrow();
    expect(() =>
      buildCheckoutUrl({ ...input, amountInCents: 1234.5 }),
    ).toThrow();
    expect(() =>
      buildCheckoutUrl({ ...input, reference: 'con espacios' }),
    ).toThrow();
  });
});

describe('buildReference', () => {
  it('deja una referencia que Wompi acepta', () => {
    const ref = buildReference({
      tenantSlug: 'barbería el corte!',
      period: '202609',
      nonce: 'a1b2c3',
    });
    expect(ref).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(ref).toContain('202609');
  });
});

describe('copToCents', () => {
  it('multiplica por cien', () => {
    expect(copToCents(79_000)).toBe(7_900_000);
  });
});
