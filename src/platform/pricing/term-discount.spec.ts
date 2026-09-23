import { PlanPricingService } from './plan-pricing.service';

/**
 * Prisma falso: solo lo que toca el cálculo del anticipo. No hace falta una base
 * real para probar aritmética, y lo que se rompe aquí se rompe en plata.
 */
type DiscountRow = {
  verticalCode: string | null;
  planCode: string | null;
  termMonths: number;
  discountBps: number;
  effectiveFrom: Date;
};

function makeService(options: {
  priceUSD?: number | null;
  rate?: number;
  discounts?: DiscountRow[];
}) {
  const discounts = options.discounts ?? [];

  const prisma = {
    planPrice: {
      findFirst: async () =>
        options.priceUSD == null ? null : { priceUSD: options.priceUSD },
      // La matriz pide todas las filas; con un solo precio alcanza para probar
      // la aritmética del término, que es lo que aquí se verifica.
      findMany: async () =>
        options.priceUSD == null
          ? []
          : (['restaurant', 'barber', 'retail'] as const).flatMap(
              (verticalCode) =>
                (['BASIC', 'PRO', 'PREMIUM'] as const).map((planCode) => ({
                  verticalCode,
                  planCode,
                  priceUSD: options.priceUSD as number,
                  effectiveFrom: new Date('2026-01-01'),
                  note: null,
                })),
            ),
    },
    platformRate: {
      findFirst: async () => ({ usdToCopRate: options.rate ?? 4000 }),
    },
    planTermDiscount: {
      // `getTermDiscountBpsAt` filtra por término y lee descendente;
      // `getTermPricingMatrixAt` las pide todas y lee ascendente. El fake
      // respeta las dos formas de llamarlo.
      findMany: async ({
        where,
        orderBy,
      }: {
        where: { termMonths?: number };
        orderBy?: { effectiveFrom: 'asc' | 'desc' };
      }) => {
        const rows = discounts.filter(
          (row) =>
            where.termMonths == null || row.termMonths === where.termMonths,
        );
        const asc = orderBy?.effectiveFrom === 'asc';
        return rows.sort((a, b) =>
          asc
            ? a.effectiveFrom.getTime() - b.effectiveFrom.getTime()
            : b.effectiveFrom.getTime() - a.effectiveFrom.getTime(),
        );
      },
    },
  };

  return new PlanPricingService(prisma as never);
}

const row = (
  partial: Partial<DiscountRow> &
    Pick<DiscountRow, 'termMonths' | 'discountBps'>,
): DiscountRow => ({
  verticalCode: null,
  planCode: null,
  effectiveFrom: new Date('2026-01-01'),
  ...partial,
});

describe('getTermDiscountBpsAt', () => {
  it('el término mensual nunca lleva descuento', async () => {
    const service = makeService({
      discounts: [row({ termMonths: 1, discountBps: 900 })],
    });
    await expect(
      service.getTermDiscountBpsAt('retail', 'PRO', 1),
    ).resolves.toBe(0);
  });

  it('sin política escrita, el descuento es 0', async () => {
    const service = makeService({ discounts: [] });
    await expect(
      service.getTermDiscountBpsAt('retail', 'PRO', 12),
    ).resolves.toBe(0);
  });

  it('usa la política global cuando no hay excepción', async () => {
    const service = makeService({
      discounts: [row({ termMonths: 12, discountBps: 1700 })],
    });
    await expect(
      service.getTermDiscountBpsAt('barber', 'BASIC', 12),
    ).resolves.toBe(1700);
  });

  it('la excepción por vertical+plan le gana a la global aunque sea más vieja', async () => {
    const service = makeService({
      discounts: [
        row({
          termMonths: 12,
          discountBps: 2000,
          effectiveFrom: new Date('2026-09-01'),
        }),
        row({
          termMonths: 12,
          discountBps: 1000,
          verticalCode: 'retail',
          planCode: 'PREMIUM',
          effectiveFrom: new Date('2026-02-01'),
        }),
      ],
    });

    // Lo específico manda: si no, publicar una global nueva borraría en
    // silencio todas las excepciones negociadas.
    await expect(
      service.getTermDiscountBpsAt('retail', 'PREMIUM', 12),
    ).resolves.toBe(1000);
    await expect(
      service.getTermDiscountBpsAt('retail', 'BASIC', 12),
    ).resolves.toBe(2000);
  });
});

describe('quoteCharge', () => {
  it('cobra lista × meses cuando no hay ningún descuento', async () => {
    const service = makeService({ priceUSD: 25, rate: 4000 });

    const quote = await service.quoteCharge({
      verticalCode: 'retail',
      planCode: 'PRO',
      termMonths: 3,
    });

    expect(quote.listMonthlyCOP).toBe(100_000);
    expect(quote.listAmount).toBe(300_000);
    expect(quote.amount).toBe(300_000);
    expect(quote.discountAmount).toBe(0);
  });

  it('aplica el anticipo sobre el término completo', async () => {
    const service = makeService({
      priceUSD: 25,
      rate: 4000,
      discounts: [row({ termMonths: 12, discountBps: 1700 })],
    });

    const quote = await service.quoteCharge({
      verticalCode: 'retail',
      planCode: 'PRO',
      termMonths: 12,
    });

    expect(quote.listAmount).toBe(1_200_000);
    expect(quote.termDiscount).toBe(204_000); // 17%
    expect(quote.amount).toBe(996_000);
  });

  it('el anticipo va sobre el precio pactado, no sobre el de lista', async () => {
    const service = makeService({
      priceUSD: 25,
      rate: 4000,
      discounts: [row({ termMonths: 6, discountBps: 1000 })],
    });

    const quote = await service.quoteCharge({
      verticalCode: 'retail',
      planCode: 'PRO',
      termMonths: 6,
      agreedMonthlyCOP: 80_000,
    });

    // Sin esto el cliente con tarifa negociada recibiría la rebaja dos veces.
    expect(quote.listAmount).toBe(600_000);
    expect(quote.commercialDiscount).toBe(120_000);
    expect(quote.termDiscount).toBe(48_000); // 10% de 480.000, no de 600.000
    expect(quote.amount).toBe(432_000);
  });

  it('mantiene el invariante lista − descuento = cobro', async () => {
    const service = makeService({
      priceUSD: 33,
      rate: 4150,
      discounts: [row({ termMonths: 6, discountBps: 1234 })],
    });

    const quote = await service.quoteCharge({
      verticalCode: 'restaurant',
      planCode: 'PRO',
      termMonths: 6,
      agreedMonthlyCOP: 121_000,
    });

    // Es el invariante de `subscription_charges`. Si se rompe, finanzas reporta
    // un ingreso que no cuadra con la suma de sus partes.
    expect(quote.listAmount - quote.discountAmount).toBe(quote.amount);
    expect(quote.commercialDiscount + quote.termDiscount).toBe(
      quote.discountAmount,
    );
  });

  it('falla si no hay precio de lista, en vez de cobrar cero', async () => {
    const service = makeService({ priceUSD: null });

    await expect(
      service.quoteCharge({
        verticalCode: 'retail',
        planCode: 'PRO',
        termMonths: 6,
      }),
    ).rejects.toThrow(/precio de lista/i);
  });
});

describe('getTermPricingMatrixAt', () => {
  it('devuelve el precio de cada término ya calculado, para la landing y el backoffice', async () => {
    const service = makeService({
      priceUSD: 25,
      rate: 4000,
      discounts: [
        row({ termMonths: 3, discountBps: 500 }),
        row({ termMonths: 6, discountBps: 1000 }),
        row({ termMonths: 12, discountBps: 1700 }),
      ],
    });

    const matrix = await service.getTermPricingMatrixAt();
    const retail = matrix.verticals.find((v) => v.verticalCode === 'retail');
    const pro = retail?.plans.find((p) => p.planCode === 'PRO');

    expect(matrix.terms).toEqual([1, 3, 6, 12]);

    // El mensual nunca lleva descuento: es el precio de lista.
    const monthly = pro?.terms.find((t) => t.termMonths === 1);
    expect(monthly).toMatchObject({ discountBps: 0, monthlyCOP: 100_000 });

    const yearly = pro?.terms.find((t) => t.termMonths === 12);
    expect(yearly).toMatchObject({
      discountBps: 1700,
      totalCOP: 996_000,
      savingCOP: 204_000,
      monthlyCOP: 83_000,
    });
  });

  it('la excepción por vertical solo mueve a esa vertical', async () => {
    const service = makeService({
      priceUSD: 25,
      rate: 4000,
      discounts: [
        row({ termMonths: 12, discountBps: 1700 }),
        row({
          termMonths: 12,
          discountBps: 1000,
          verticalCode: 'barber',
          effectiveFrom: new Date('2026-03-01'),
        }),
      ],
    });

    const matrix = await service.getTermPricingMatrixAt();
    const bpsFor = (vertical: string) =>
      matrix.verticals
        .find((v) => v.verticalCode === vertical)
        ?.plans.find((p) => p.planCode === 'PRO')
        ?.terms.find((t) => t.termMonths === 12)?.discountBps;

    expect(bpsFor('barber')).toBe(1000);
    expect(bpsFor('retail')).toBe(1700);
  });
});

describe('redondeo comercial', () => {
  // El caso que destapó el bug: con una tasa que no divide redondo, descontar
  // sobre el COP ya convertido daba $69.350 y $110.200 en la landing. El
  // descuento va sobre el USD (el ancla) y el COP se deriva después.
  it('descuenta en USD y convierte, dejando precios de lista publicables', async () => {
    const service = makeService({
      priceUSD: 12,
      rate: 3333,
      discounts: [
        row({ termMonths: 3, discountBps: 500 }),
        row({ termMonths: 12, discountBps: 1700 }),
      ],
    });

    const matrix = await service.getTermPricingMatrixAt();
    const basic = matrix.verticals
      .find((v) => v.verticalCode === 'retail')
      ?.plans.find((p) => p.planCode === 'BASIC');

    const quarter = basic?.terms.find((t) => t.termMonths === 3);
    expect(quarter?.monthlyUSD).toBe(11.4);
    expect(quarter?.monthlyCOP).toBe(38_000);
    // El total es el mensual por los meses: el cliente puede verificarlo solo.
    expect(quarter?.totalCOP).toBe(114_000);

    const yearly = basic?.terms.find((t) => t.termMonths === 12);
    expect(yearly?.monthlyUSD).toBe(9.96);
    expect(yearly?.monthlyCOP).toBe(33_000);
    expect(yearly?.totalCOP).toBe(396_000);
  });

  it('redondea al escalón de 500, no de 1000', async () => {
    // 22 USD a 3.333 "vale" 73.326. A mil se publicaba 73.000 —326 pesos
    // regalados por mes—; a quinientos queda 73.500, que es el escalón más
    // cercano al precio real sin dejar de ser una cifra decible.
    const service = makeService({
      priceUSD: 22,
      rate: 3333,
      discounts: [row({ termMonths: 3, discountBps: 500 })],
    });

    const matrix = await service.getTermPricingMatrixAt();
    const pro = matrix.verticals
      .find((v) => v.verticalCode === 'retail')
      ?.plans.find((p) => p.planCode === 'PRO');

    expect(pro?.priceCOP).toBe(73_500);

    const quarter = pro?.terms.find((t) => t.termMonths === 3);
    expect(quarter?.monthlyUSD).toBe(20.9);
    expect(quarter?.monthlyCOP).toBe(69_500);
    expect(quarter?.totalCOP).toBe(208_500);
    expect(quarter?.savingCOP).toBe(12_000);
  });

  it('el cobro también sale redondo y el total es mensual × meses', async () => {
    const service = makeService({
      priceUSD: 12,
      rate: 3333,
      discounts: [row({ termMonths: 6, discountBps: 1000 })],
    });

    const quote = await service.quoteCharge({
      verticalCode: 'retail',
      planCode: 'BASIC',
      termMonths: 6,
    });

    expect(quote.chargedMonthlyCOP).toBe(36_000);
    expect(quote.amount).toBe(216_000);
    expect(quote.amount).toBe(quote.chargedMonthlyCOP * quote.termMonths);
    // El invariante contable sigue en pie pese al redondeo.
    expect(quote.listAmount - quote.discountAmount).toBe(quote.amount);
  });
});
