-- Siembra las tarifas vigentes al momento de introducir el histórico.
--
-- Sin esto, `getPlanPriceAt` no encontraría precio para ninguna fecha anterior al
-- primer cambio hecho desde el backoffice, y los cobros nuevos se quedarían sin
-- precio de referencia. Los valores son los que estaban hardcodeados en el
-- frontend (core/config/pricing.config.ts): BASIC 20, PRO 33, PREMIUM 56 USD.
--
-- `effective_from` va muy en el pasado a propósito: representa "esto es lo que
-- se cobraba desde siempre hasta el primer cambio real".
-- Ids fijos + ON CONFLICT: la migración es idempotente.

INSERT INTO "plan_prices" ("id", "verticalCode", "planCode", "priceUSD", "effectiveFrom", "note", "createdAt")
VALUES
  ('seed-price-restaurant-basic',   'restaurant', 'BASIC',   20, '2020-01-01T00:00:00Z', 'Tarifa inicial (migrada del config del frontend)', NOW()),
  ('seed-price-restaurant-pro',     'restaurant', 'PRO',     33, '2020-01-01T00:00:00Z', 'Tarifa inicial (migrada del config del frontend)', NOW()),
  ('seed-price-restaurant-premium', 'restaurant', 'PREMIUM', 56, '2020-01-01T00:00:00Z', 'Tarifa inicial (migrada del config del frontend)', NOW()),
  ('seed-price-barber-basic',       'barber',     'BASIC',   20, '2020-01-01T00:00:00Z', 'Tarifa inicial (migrada del config del frontend)', NOW()),
  ('seed-price-barber-pro',         'barber',     'PRO',     33, '2020-01-01T00:00:00Z', 'Tarifa inicial (migrada del config del frontend)', NOW()),
  ('seed-price-barber-premium',     'barber',     'PREMIUM', 56, '2020-01-01T00:00:00Z', 'Tarifa inicial (migrada del config del frontend)', NOW()),
  ('seed-price-retail-basic',       'retail',     'BASIC',   20, '2020-01-01T00:00:00Z', 'Tarifa inicial (migrada del config del frontend)', NOW()),
  ('seed-price-retail-pro',         'retail',     'PRO',     33, '2020-01-01T00:00:00Z', 'Tarifa inicial (migrada del config del frontend)', NOW()),
  ('seed-price-retail-premium',     'retail',     'PREMIUM', 56, '2020-01-01T00:00:00Z', 'Tarifa inicial (migrada del config del frontend)', NOW())
ON CONFLICT ("id") DO NOTHING;

-- La tasa vigente arranca desde la fila única que ya existía (o 3650 si no había).
INSERT INTO "platform_rates" ("id", "usdToCopRate", "effectiveFrom", "note", "createdAt")
SELECT
  'seed-rate-initial',
  COALESCE((SELECT "usdToCopRate" FROM "platform_pricing_config" WHERE "id" = 'singleton'), 3650),
  '2020-01-01T00:00:00Z',
  'Tasa inicial (migrada de platform_pricing_config)',
  NOW()
ON CONFLICT ("id") DO NOTHING;
