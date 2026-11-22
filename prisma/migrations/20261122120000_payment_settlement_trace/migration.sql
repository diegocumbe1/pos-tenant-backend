-- Trazabilidad interna del cobro: canal, cuenta de abono, fecha esperada y real
-- de llegada, comisión y neto (solo superadmin).
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AÑADE columnas nullable: no reescribe ni toca filas.
--   · Idempotente: IF NOT EXISTS en cada columna.
--   · Los pagos existentes quedan sin trazabilidad (NULL) y se siguen tratando
--     como plata ya recibida el día en que se registraron.

ALTER TABLE "subscription_payments"
  ADD COLUMN IF NOT EXISTS "channel"              TEXT,
  ADD COLUMN IF NOT EXISTS "settlementAccount"    TEXT,
  ADD COLUMN IF NOT EXISTS "expectedSettlementAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "settledAt"            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "feeCOP"               INTEGER,
  ADD COLUMN IF NOT EXISTS "netCOP"               INTEGER,
  ADD COLUMN IF NOT EXISTS "internalNote"         TEXT;
