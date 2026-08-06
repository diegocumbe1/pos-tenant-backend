-- CreateEnum
CREATE TYPE "PlatformMessageChannel" AS ENUM ('WHATSAPP', 'EMAIL');

-- CreateEnum
CREATE TYPE "PlatformMessageStatus" AS ENUM ('SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "platform_message_templates" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "channel" "PlatformMessageChannel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "bodyText" TEXT,
    "variables" TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_payment_methods" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "holder" TEXT,
    "reference" TEXT,
    "bank" TEXT,
    "accountType" TEXT,
    "document" TEXT,
    "instructions" TEXT,
    "qrImageUrl" TEXT,
    "qrPdfUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "templateKey" TEXT,
    "channel" "PlatformMessageChannel" NOT NULL,
    "status" "PlatformMessageStatus" NOT NULL DEFAULT 'SENDING',
    "to" TEXT NOT NULL,
    "toName" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "attachments" JSONB,
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "providerId" TEXT,
    "skipReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "jobKey" TEXT,
    "dedupeKey" TEXT,
    "scheduledFor" TIMESTAMP(3),

    CONSTRAINT "platform_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_messaging_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "waEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "fromEmail" TEXT,
    "fromName" TEXT,
    "replyTo" TEXT,
    "signature" TEXT DEFAULT 'Equipo Lynko',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_messaging_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_message_templates_key_key" ON "platform_message_templates"("key");

-- CreateIndex
CREATE INDEX "platform_message_templates_channel_idx" ON "platform_message_templates"("channel");

-- CreateIndex
CREATE INDEX "platform_payment_methods_isActive_sortOrder_idx" ON "platform_payment_methods"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "platform_messages_dedupeKey_key" ON "platform_messages"("dedupeKey");

-- CreateIndex
CREATE INDEX "platform_messages_tenantId_createdAt_idx" ON "platform_messages"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "platform_messages_status_createdAt_idx" ON "platform_messages"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "platform_messages" ADD CONSTRAINT "platform_messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

