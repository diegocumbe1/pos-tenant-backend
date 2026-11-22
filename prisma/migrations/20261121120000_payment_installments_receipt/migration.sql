-- Comprobante de pago público + planes pagados en cuotas (subscription_payments).
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AÑADE columnas nullable y dos índices: no reescribe ni toca filas.
--   · Idempotente: IF NOT EXISTS en cada columna e índice.
--   · Los pagos existentes quedan en NULL (pago único, sin enlace); el enlace se
--     genera a pedido desde el backoffice.

ALTER TABLE "subscription_payments"
  ADD COLUMN IF NOT EXISTS "receiptToken"       TEXT,
  ADD COLUMN IF NOT EXISTS "installmentGroupId" TEXT,
  ADD COLUMN IF NOT EXISTS "installmentNo"      INTEGER,
  ADD COLUMN IF NOT EXISTS "installmentsTotal"  INTEGER,
  ADD COLUMN IF NOT EXISTS "planTotal"          INTEGER,
  ADD COLUMN IF NOT EXISTS "planListTotal"      INTEGER,
  ADD COLUMN IF NOT EXISTS "balanceAfter"       INTEGER,
  ADD COLUMN IF NOT EXISTS "nextDueAt"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "nextDueAmount"      INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS "subscription_payments_receiptToken_key"
  ON "subscription_payments"("receiptToken");

CREATE INDEX IF NOT EXISTS "subscription_payments_installmentGroupId_idx"
  ON "subscription_payments"("installmentGroupId");
