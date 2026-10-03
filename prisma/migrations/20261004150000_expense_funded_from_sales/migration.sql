-- Cuánto de un gasto declaró el dueño que pagó con plata de las ventas.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo agrega una columna NULL sin default: cambio de metadatos, no
--     reescribe ni bloquea `expenses`, no toca datos existentes.
--   · Idempotente (IF NOT EXISTS).

ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "fundedFromSalesCOP" INTEGER;
