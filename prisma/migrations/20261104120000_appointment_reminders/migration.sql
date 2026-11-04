-- Recordatorios de agenda (1 día antes, 1 hora antes…), por rol y por persona.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo crea dos tablas nuevas e índices. No toca tablas ni datos existentes.
--   · Sin reglas no sale ningún recordatorio: ningún negocio empieza a recibir
--     avisos por desplegar esto.
--   · Idempotente: IF NOT EXISTS y constraints protegidos con un bloque DO.

CREATE TABLE IF NOT EXISTS "appointment_reminder_rules" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "roleCode" TEXT,
  "userId" TEXT,
  "offsetsMinutes" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
  "scope" TEXT NOT NULL DEFAULT 'ALL',
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "appointment_reminder_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_reminder_rules_tenantId_roleCode_key"
  ON "appointment_reminder_rules"("tenantId", "roleCode");
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_reminder_rules_tenantId_userId_key"
  ON "appointment_reminder_rules"("tenantId", "userId");

CREATE TABLE IF NOT EXISTS "appointment_reminder_deliveries" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "itemKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "minutesBefore" INTEGER NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "appointment_reminder_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_reminder_deliveries_itemKey_userId_minutesBefore_scheduledAt_key"
  ON "appointment_reminder_deliveries"("itemKey", "userId", "minutesBefore", "scheduledAt");
CREATE INDEX IF NOT EXISTS "appointment_reminder_deliveries_createdAt_idx"
  ON "appointment_reminder_deliveries"("createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointment_reminder_rules_tenantId_fkey') THEN
    ALTER TABLE "appointment_reminder_rules" ADD CONSTRAINT "appointment_reminder_rules_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointment_reminder_rules_userId_fkey') THEN
    ALTER TABLE "appointment_reminder_rules" ADD CONSTRAINT "appointment_reminder_rules_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
