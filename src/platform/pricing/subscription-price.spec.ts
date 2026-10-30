import { Prisma } from '@prisma/client';
import { subscriptionPriceAt, SubscriptionPriceFields } from './subscription-price';

// PRO de barber: 25 USD. Tasa 3.300 hasta el 24-oct, 3.180 desde ese día.
const RATES = [
  { effectiveFrom: new Date('2026-01-01T00:00:00Z'), usdToCopRate: 3300 },
  { effectiveFrom: new Date('2026-10-24T05:00:00Z'), usdToCopRate: 3180 },
];
const PRICES = [
  { verticalCode: 'barber', planCode: 'PRO', effectiveFrom: new Date('2026-01-01T00:00:00Z'), priceUSD: 25 },
];

function latest<T extends { effectiveFrom: Date }>(rows: T[], at: Date): T | null {
  return [...rows].filter((r) => r.effectiveFrom <= at).sort((a, b) => +b.effectiveFrom - +a.effectiveFrom)[0] ?? null;
}

const db = {
  planPrice: {
    findFirst: ({ where }: { where: { verticalCode: string; planCode: string; effectiveFrom: { lte: Date } } }) =>
      Promise.resolve(
        latest(
          PRICES.filter((p) => p.verticalCode === where.verticalCode && p.planCode === where.planCode),
          where.effectiveFrom.lte,
        ),
      ),
  },
  platformRate: {
    findFirst: ({ where }: { where: { effectiveFrom: { lte: Date } } }) =>
      Promise.resolve(latest(RATES, where.effectiveFrom.lte)),
  },
} as unknown as Prisma.TransactionClient;

// Lo que quedó guardado al asignar el plan el 12-oct, con la tasa de entonces.
const assignedOct12: SubscriptionPriceFields = {
  agreedPriceCOP: 82500,
  agreedPriceUSD: 25,
  priceCOP: 82500,
  priceUSD: 25,
  agreedPriceLockedAt: null,
};

const priceAt = (subscription: SubscriptionPriceFields | null, at: string, verticalCode: string | null = 'barber') =>
  subscriptionPriceAt(db, { verticalCode, planCode: 'PRO', subscription, at: new Date(at) });

describe('subscriptionPriceAt', () => {
  it('sin precio fijado, cada cobro va con la tarifa de su fecha', async () => {
    // Pagó el 12-oct a 82.500; la tasa cambió el 24: el 12-nov se cobra 79.500.
    expect((await priceAt(assignedOct12, '2026-10-12T15:00:00Z')).priceCOP).toBe(82500);
    const nov = await priceAt(assignedOct12, '2026-11-12T15:00:00Z');
    expect(nov.priceCOP).toBe(79500);
    expect(nov.locked).toBe(false);
  });

  it('un precio fijado por el admin no se mueve con la tarifa', async () => {
    const fixed = { ...assignedOct12, agreedPriceCOP: 70000, priceCOP: 70000, agreedPriceLockedAt: new Date('2026-10-01') };
    const nov = await priceAt(fixed, '2026-11-12T15:00:00Z');
    expect(nov.priceCOP).toBe(70000);
    expect(nov.listCOP).toBe(79500);
    expect(nov.locked).toBe(true);
  });

  it('sin tarifa cargada para el vertical, cae a lo guardado', async () => {
    expect((await priceAt(assignedOct12, '2026-11-12T15:00:00Z', null)).priceCOP).toBe(82500);
  });
});
