-- Trazabilidad: quién hizo cada acción en una mesa (tomar pedido, enviar, entregar, cobrar).
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AÑADE columnas nullable, un índice y un valor al enum: no reescribe filas ni cambia datos.
--   · Idempotente: IF NOT EXISTS en columnas, índice y valor del enum.
--   · Los eventos anteriores quedan con actor NULL ("sin registro"); el historial viejo no se inventa.

ALTER TABLE "order_events" ADD COLUMN IF NOT EXISTS "actorId" TEXT;
ALTER TABLE "order_events" ADD COLUMN IF NOT EXISTS "actorName" TEXT;
ALTER TABLE "order_events" ADD COLUMN IF NOT EXISTS "actorRole" TEXT;

CREATE INDEX IF NOT EXISTS "order_events_tenantId_actorId_at_idx"
  ON "order_events" ("tenantId", "actorId", "at");

ALTER TYPE "OrderEventType" ADD VALUE IF NOT EXISTS 'ITEM_SERVED';
