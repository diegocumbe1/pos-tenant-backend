import { Prisma } from '@prisma/client';
import { DEFAULT_USD_TO_COP_RATE, usdToCop } from './plan-pricing.service';

type Db = Prisma.TransactionClient;

/** Lo de la suscripción que decide el precio. */
export interface SubscriptionPriceFields {
  agreedPriceCOP: number | null;
  agreedPriceUSD: number | null;
  priceCOP: number | null;
  priceUSD: number | null;
  agreedPriceLockedAt: Date | null;
}

export interface SubscriptionPriceAt {
  /** Tarifa de lista vigente en `at`. null si el vertical no tiene tarifa cargada. */
  listCOP: number | null;
  listUSD: number | null;
  /** Lo que se cobra por mes en `at`. */
  priceCOP: number | null;
  priceUSD: number | null;
  /** true = lo fijó el admin y no sigue la tarifa. */
  locked: boolean;
}

/**
 * Precio mensual de una suscripción en una fecha. ES LA REGLA DEL COBRO:
 *
 * 1. El admin lo fijó (precio especial, descuento) → ese, aunque la tarifa cambie.
 * 2. Si no → la tarifa de lista vigente en ESA fecha. Pagó el 12 a $X, la tarifa
 *    cambió el 24 a $Y: el siguiente 12 se cobra $Y, suba o baje.
 *
 * El anticipo (3/6/12 meses) no pasa por aquí: lo pagado queda en el pago de su
 * término y el siguiente cobro, al terminar, vuelve a esta regla.
 *
 * Sin tarifa cargada para el vertical/plan, cae al último precio guardado.
 */
export async function subscriptionPriceAt(
  db: Db,
  input: {
    verticalCode: string | null | undefined;
    planCode: string;
    subscription: SubscriptionPriceFields | null;
    at?: Date;
  },
): Promise<SubscriptionPriceAt> {
  const at = input.at ?? new Date();
  const sub = input.subscription;
  const list = input.verticalCode
    ? await listPriceAt(db, input.verticalCode, input.planCode, at)
    : null;
  const locked = !!sub?.agreedPriceLockedAt;

  const storedCOP = sub?.agreedPriceCOP ?? sub?.priceCOP ?? null;
  const storedUSD = sub?.agreedPriceUSD ?? sub?.priceUSD ?? null;
  return {
    listCOP: list?.priceCOP ?? null,
    listUSD: list?.priceUSD ?? null,
    priceCOP: locked ? storedCOP : (list?.priceCOP ?? storedCOP),
    priceUSD: locked ? storedUSD : (list?.priceUSD ?? storedUSD),
    locked,
  };
}

/** Tarifa de lista USD + su COP con la tasa de la misma fecha. */
async function listPriceAt(
  db: Db,
  verticalCode: string,
  planCode: string,
  at: Date,
): Promise<{ priceUSD: number; priceCOP: number } | null> {
  const [price, rate] = await Promise.all([
    db.planPrice.findFirst({
      where: { verticalCode, planCode, effectiveFrom: { lte: at } },
      orderBy: { effectiveFrom: 'desc' },
    }),
    db.platformRate.findFirst({
      where: { effectiveFrom: { lte: at } },
      orderBy: { effectiveFrom: 'desc' },
    }),
  ]);
  if (!price) return null;
  const usdToCopRate = rate?.usdToCopRate ?? DEFAULT_USD_TO_COP_RATE;
  return { priceUSD: price.priceUSD, priceCOP: usdToCop(price.priceUSD, usdToCopRate) };
}

/**
 * Lleva el precio guardado de las suscripciones que siguen la tarifa a la
 * tarifa de hoy. Lo guardado es lo que leen el backoffice, el MRR y la app del
 * negocio; el cobro igual consulta la tarifa de su fecha con
 * `subscriptionPriceAt`. Se llama al publicar una tarifa o una tasa nueva.
 * Las fijadas por el admin no se tocan.
 */
export async function syncUnlockedSubscriptionPrices(
  db: Db,
  at: Date = new Date(),
  tenantId?: string,
): Promise<number> {
  const subs = await db.subscription.findMany({
    where: {
      agreedPriceLockedAt: null,
      canceledAt: null,
      ...(tenantId ? { tenantId } : {}),
    },
    select: {
      id: true,
      plan: true,
      agreedPriceCOP: true,
      agreedPriceUSD: true,
      tenant: { select: { vertical: { select: { code: true } } } },
    },
  });

  let updated = 0;
  for (const sub of subs) {
    const code = sub.tenant.vertical?.code;
    if (!code) continue;
    const list = await listPriceAt(db, code, sub.plan, at);
    if (!list) continue;
    if (sub.agreedPriceCOP === list.priceCOP && sub.agreedPriceUSD === list.priceUSD) continue;
    await db.subscription.update({
      where: { id: sub.id },
      data: {
        listPriceCOP: list.priceCOP,
        listPriceUSD: list.priceUSD,
        agreedPriceCOP: list.priceCOP,
        agreedPriceUSD: list.priceUSD,
        priceCOP: list.priceCOP,
        priceUSD: list.priceUSD,
      },
    });
    updated += 1;
  }
  return updated;
}
