-- Fecha programada de pago (`dueAt`) separada de la fecha real de caja (`incurredAt`)
-- en los gastos de plataforma: así un cobro recurrente conserva su vencimiento
-- aunque se corrija el día en que de verdad se pagó.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Añade UNA columna nullable (IF NOT EXISTS): no reescribe la tabla.
--   · El relleno solo toca cobros de contratos recurrentes que aún no tienen
--     `dueAt`, y le pone la fecha del ciclo (`periodStart`, que nunca se edita;
--     si faltara, `incurredAt`). No cambia importes, estados ni fechas de caja.
--   · Idempotente: repetirla no cambia nada.

ALTER TABLE "platform_expenses" ADD COLUMN IF NOT EXISTS "dueAt" TIMESTAMP(3);

UPDATE "platform_expenses"
   SET "dueAt" = COALESCE("periodStart", "incurredAt")
 WHERE "kind" = 'recurring'
   AND "dueAt" IS NULL;
