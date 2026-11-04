-- Elegir qué avisos recibir (todas / solo las que elija / ninguna, con filtros) y
-- pausarlos por un tiempo.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo agrega tres columnas a `appointment_reminder_rules` y una tabla nueva.
--   · `mode` por defecto 'ALL', `filters` NULL y `locked` en false: una regla ya guardada sigue
--     funcionando igual.
--   · Idempotente: IF NOT EXISTS.

ALTER TABLE "appointment_reminder_rules" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'ALL';
ALTER TABLE "appointment_reminder_rules" ADD COLUMN IF NOT EXISTS "filters" JSONB;
ALTER TABLE "appointment_reminder_rules" ADD COLUMN IF NOT EXISTS "locked" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "notification_pauses" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "pausedUntil" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_pauses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "notification_pauses_userId_key"
  ON "notification_pauses"("userId");
