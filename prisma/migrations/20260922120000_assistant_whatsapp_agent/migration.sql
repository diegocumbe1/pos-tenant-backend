-- Agente de Lynko por WhatsApp (fase 1): identidad por teléfono + contexto.

-- El canal nuevo de telemetría. Va primero y en su propia sentencia: en
-- PostgreSQL un valor de enum recién agregado no se puede usar en la misma
-- transacción que lo agregó.
ALTER TYPE "AssistantChannel" ADD VALUE IF NOT EXISTS 'WHATSAPP';

-- Teléfono del usuario. SIN unique: quien tiene dos negocios tiene dos filas de
-- `users` (una por tenant) con el mismo número, y ese es el caso que el agente
-- resuelve preguntando de cuál negocio se habla.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" TEXT;
CREATE INDEX IF NOT EXISTS "users_phone_idx" ON "users"("phone");

DO $$ BEGIN
  CREATE TYPE "AssistantConversationMode" AS ENUM ('AGENT', 'HUMAN', 'HYBRID');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "assistant_conversations" (
    "id" TEXT NOT NULL,
    "channel" "AssistantChannel" NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "personId" TEXT,
    "tenantId" TEXT,
    "lastIntent" TEXT,
    "lastSlots" JSONB,
    "lastOptions" JSONB,
    "mode" "AssistantConversationMode" NOT NULL DEFAULT 'HYBRID',
    "humanTakeoverUntil" TIMESTAMP(3),
    "lastInteractionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAgentReplyAt" TIMESTAMP(3),
    "greetedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "assistant_conversations_channel_externalUserId_key"
    ON "assistant_conversations"("channel", "externalUserId");
CREATE INDEX IF NOT EXISTS "assistant_conversations_personId_idx"
    ON "assistant_conversations"("personId");
CREATE INDEX IF NOT EXISTS "assistant_conversations_tenantId_idx"
    ON "assistant_conversations"("tenantId");

ALTER TABLE "assistant_conversations"
    ADD CONSTRAINT "assistant_conversations_personId_fkey"
    FOREIGN KEY ("personId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "assistant_conversations"
    ADD CONSTRAINT "assistant_conversations_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- El interruptor del agente vive en la consola, no en el entorno: apagarlo no
-- puede depender de un redeploy. Arranca en false.
ALTER TABLE "platform_messaging_settings"
    ADD COLUMN IF NOT EXISTS "agentEnabled" BOOLEAN NOT NULL DEFAULT false;
