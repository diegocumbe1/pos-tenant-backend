-- Calendario de pago de nómina: días de pago y fecha de arranque del contrato.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AÑADE dos columnas: una lista vacía por defecto y una nullable. No
--     reescribe ni cambia el significado de ninguna fila existente.
--   · Idempotente: IF NOT EXISTS en cada columna.
--   · Con la lista vacía el sistema usa los días de siempre (quincenal 15 y fin
--     de mes, mensual fin de mes), así que nadie queda sin calendario.

ALTER TABLE "staff_compensations"
  ADD COLUMN IF NOT EXISTS "payDays"      INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN IF NOT EXISTS "payStartDate" TEXT;
