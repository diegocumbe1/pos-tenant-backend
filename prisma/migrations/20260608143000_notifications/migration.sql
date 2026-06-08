-- Notification contracts for in-app feed, Web Push subscriptions and future external delivery.
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'WEB_PUSH', 'EMAIL', 'WHATSAPP');
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED');

CREATE TABLE "notification_events" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT,
  "userId" TEXT,
  "vertical" TEXT NOT NULL DEFAULT 'shared',
  "type" TEXT NOT NULL,
  "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
  "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
  "title" TEXT NOT NULL,
  "body" TEXT,
  "recipient" JSONB,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "readAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_preferences" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT,
  "vertical" TEXT,
  "type" TEXT NOT NULL,
  "inApp" BOOLEAN NOT NULL DEFAULT true,
  "webPush" BOOLEAN NOT NULL DEFAULT false,
  "email" BOOLEAN NOT NULL DEFAULT false,
  "whatsapp" BOOLEAN NOT NULL DEFAULT false,
  "quietStart" TEXT,
  "quietEnd" TEXT,
  "timezone" TEXT NOT NULL DEFAULT 'America/Bogota',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "web_push_subscriptions" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT,
  "userId" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "expirationTime" TIMESTAMP(3),
  "userAgent" TEXT,
  "deviceLabel" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "web_push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notification_events_tenantId_branchId_createdAt_idx"
  ON "notification_events"("tenantId", "branchId", "createdAt");
CREATE INDEX "notification_events_tenantId_userId_readAt_createdAt_idx"
  ON "notification_events"("tenantId", "userId", "readAt", "createdAt");
CREATE INDEX "notification_events_tenantId_type_createdAt_idx"
  ON "notification_events"("tenantId", "type", "createdAt");
CREATE INDEX "notification_events_tenantId_status_channel_createdAt_idx"
  ON "notification_events"("tenantId", "status", "channel", "createdAt");

CREATE UNIQUE INDEX "notification_preferences_tenantId_userId_vertical_type_key"
  ON "notification_preferences"("tenantId", "userId", "vertical", "type");
CREATE INDEX "notification_preferences_tenantId_userId_idx"
  ON "notification_preferences"("tenantId", "userId");
CREATE INDEX "notification_preferences_tenantId_vertical_type_idx"
  ON "notification_preferences"("tenantId", "vertical", "type");

CREATE UNIQUE INDEX "web_push_subscriptions_endpoint_key"
  ON "web_push_subscriptions"("endpoint");
CREATE INDEX "web_push_subscriptions_tenantId_userId_isActive_idx"
  ON "web_push_subscriptions"("tenantId", "userId", "isActive");
CREATE INDEX "web_push_subscriptions_tenantId_branchId_isActive_idx"
  ON "web_push_subscriptions"("tenantId", "branchId", "isActive");

ALTER TABLE "notification_events"
  ADD CONSTRAINT "notification_events_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_events"
  ADD CONSTRAINT "notification_events_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "notification_events"
  ADD CONSTRAINT "notification_events_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "web_push_subscriptions"
  ADD CONSTRAINT "web_push_subscriptions_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "web_push_subscriptions"
  ADD CONSTRAINT "web_push_subscriptions_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "web_push_subscriptions"
  ADD CONSTRAINT "web_push_subscriptions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
