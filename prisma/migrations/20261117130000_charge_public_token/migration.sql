-- Enlace público del ticket de cobro (`/cobro/<token>`).
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AÑADE una columna nullable y un índice único: no reescribe filas.
--   · Idempotente: IF NOT EXISTS en columna e índice.
--   · Los cobros existentes quedan en NULL; el admin les genera el enlace a pedido.

ALTER TABLE "subscription_charges" ADD COLUMN IF NOT EXISTS "publicToken" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "subscription_charges_publicToken_key"
  ON "subscription_charges"("publicToken");
