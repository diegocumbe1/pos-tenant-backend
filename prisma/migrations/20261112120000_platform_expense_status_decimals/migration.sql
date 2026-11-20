-- Gastos de plataforma: centavos (US$ 5.72), estado pagado/pendiente,
-- clasificación (nature) y TRM por gasto (exchangeRate, ambas NULL).
--
-- 1) amount INTEGER -> DOUBLE PRECISION: conversión sin pérdida (todo entero es
--    exacto en double). Es el ÚNICO cambio que no es puramente aditivo, y es
--    necesario para guardar US$ 5.72. Tablas de decenas de filas.
-- 2) status con default 'paid': todo lo existente queda como plata ya pagada,
--    así que ningún total histórico cambia.
-- Idempotente: se puede correr dos veces.

DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_name = 'platform_expenses' AND column_name = 'amount') = 'integer' THEN
    ALTER TABLE "platform_expenses" ALTER COLUMN "amount" TYPE DOUBLE PRECISION;
  END IF;
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_name = 'platform_recurring_expenses' AND column_name = 'amount') = 'integer' THEN
    ALTER TABLE "platform_recurring_expenses" ALTER COLUMN "amount" TYPE DOUBLE PRECISION;
  END IF;
END $$;

ALTER TABLE "platform_expenses" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'paid';

ALTER TABLE "platform_expenses" ADD COLUMN IF NOT EXISTS "nature" TEXT;
ALTER TABLE "platform_expenses" ADD COLUMN IF NOT EXISTS "exchangeRate" DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS "platform_expenses_status_incurredAt_idx"
  ON "platform_expenses" ("status", "incurredAt");
