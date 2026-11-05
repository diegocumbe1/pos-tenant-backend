-- Avisos del super-admin: vencimientos de suscripción y sus dispositivos push.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo crea dos tablas nuevas; no toca ninguna existente.
--   · Sin dispositivos activados nadie recibe push: los avisos solo quedan en la consola.
--   · No bloquea ni cambia ninguna cuenta.
--   · Idempotente: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "platform_push_subscriptions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "userAgent" TEXT,
  "deviceLabel" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_push_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "platform_push_subscriptions_endpoint_key"
  ON "platform_push_subscriptions"("endpoint");
CREATE INDEX IF NOT EXISTS "platform_push_subscriptions_userId_isActive_idx"
  ON "platform_push_subscriptions"("userId", "isActive");

CREATE TABLE IF NOT EXISTS "platform_alerts" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "dueDay" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "pushedAt" TIMESTAMP(3),
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_alerts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "platform_alerts_type_tenantId_dueDay_key"
  ON "platform_alerts"("type", "tenantId", "dueDay");
CREATE INDEX IF NOT EXISTS "platform_alerts_createdAt_idx"
  ON "platform_alerts"("createdAt");
