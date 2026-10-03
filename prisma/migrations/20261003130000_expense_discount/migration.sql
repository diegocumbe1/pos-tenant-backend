-- Descuento recibido en un gasto (p. ej. la suscripción con 100% de descuento).
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo agrega una columna NULL sin default: cambio de metadatos, no
--     reescribe ni bloquea `expenses`.
--   · No toca ningún dato existente: los gastos viejos quedan "sin descuento".
--   · Idempotente (IF NOT EXISTS).
--
-- `amountCOP` sigue siendo lo pagado; `discountCOP` solo informa el ahorro.

ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "discountCOP" INTEGER;
