-- Tarifas de los servicios de catálogo gestionado.
--
-- APPEND-ONLY con fecha efectiva, igual que `plan_prices`: guardar no
-- sobrescribe, crea una tarifa nueva. Un catálogo cobrado en septiembre
-- conserva el precio de septiembre aunque la tarifa suba en diciembre.
--
-- Ver docs/CATALOGO_EXPRESS_COSTOS.md.

CREATE TABLE "catalog_service_prices" (
  "id"            TEXT NOT NULL,
  -- SETUP | SEASON_UPDATE | YEAR_BUNDLE | EXTRA_PRODUCT
  "serviceCode"   TEXT NOT NULL,
  -- EN CENTAVOS: "producto adicional" vale 0,50 USD y con dólares enteros
  -- habría que regalarlo o cobrar el doble.
  "priceUsdCents" INTEGER NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "note"          TEXT,
  "createdBy"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "catalog_service_prices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catalog_service_prices_serviceCode_effectiveFrom_idx"
  ON "catalog_service_prices"("serviceCode", "effectiveFrom");

-- Tarifas de arranque, con fecha muy anterior para que sean las vigentes desde
-- siempre. Son los valores del documento; se cambian desde el backoffice.
INSERT INTO "catalog_service_prices"
  ("id", "serviceCode", "priceUsdCents", "effectiveFrom", "note")
VALUES
  ('cspseed_setup',  'SETUP',         2500, '2020-01-01 00:00:00', 'Tarifa inicial'),
  ('cspseed_season', 'SEASON_UPDATE',  800, '2020-01-01 00:00:00', 'Tarifa inicial'),
  ('cspseed_bundle', 'YEAR_BUNDLE',   5000, '2020-01-01 00:00:00', 'Tarifa inicial'),
  ('cspseed_extra',  'EXTRA_PRODUCT',   50, '2020-01-01 00:00:00', 'Tarifa inicial');
