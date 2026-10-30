-- Precio pactado FIJO vs. precio que sigue la tarifa.
--
-- Antes, al asignar un plan se copiaba la lista del momento a `agreedPriceCOP`
-- y ese número quedaba congelado para siempre: si la tasa USD→COP bajaba, el
-- cliente seguía cobrándose al precio viejo. La regla es otra: el precio solo
-- se conserva si el admin lo fijó (precio especial / descuento) o si el cliente
-- pagó por adelantado (eso ya vive en el pago de su término). Sin eso, cada
-- cobro va con la tarifa de SU fecha.
--
-- `agreedPriceLockedAt` != NULL = lo fijó el admin y manda. NULL = sigue la lista.
--
-- Aditiva e idempotente. Backfill: quedan fijas solo las que tienen un
-- descuento real (pactado por debajo de la lista) o un motivo de descuento.
-- Las demás eran la lista copiada, no una decisión de nadie.
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "agreedPriceLockedAt" TIMESTAMP(3);

UPDATE "subscriptions"
SET "agreedPriceLockedAt" = "updatedAt"
WHERE "agreedPriceLockedAt" IS NULL
  AND (
    "discountReason" IS NOT NULL
    OR ("listPriceCOP" IS NOT NULL AND "agreedPriceCOP" IS NOT NULL AND "agreedPriceCOP" < "listPriceCOP")
    OR ("listPriceUSD" IS NOT NULL AND "agreedPriceUSD" IS NOT NULL AND "agreedPriceUSD" < "listPriceUSD")
  );
