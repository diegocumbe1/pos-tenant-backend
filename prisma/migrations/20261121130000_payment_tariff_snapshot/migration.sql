-- Tarifa vigente al contratar, congelada en cada pago (nota legal del comprobante).
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AÑADE columnas nullable: no reescribe ni toca filas.
--   · Idempotente: IF NOT EXISTS en cada columna.
--   · Los pagos existentes quedan en NULL y el comprobante simplemente no
--     muestra la nota de tarifa.

ALTER TABLE "subscription_payments"
  ADD COLUMN IF NOT EXISTS "tariffTermMonths"  INTEGER,
  ADD COLUMN IF NOT EXISTS "tariffListMonthly" INTEGER,
  ADD COLUMN IF NOT EXISTS "tariffDiscountBps" INTEGER,
  ADD COLUMN IF NOT EXISTS "tariffTableTotal"  INTEGER;
