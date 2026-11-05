-- Borradores del agente de Lynko: lo que propone y una persona confirma.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo agrega un tipo, una tabla nueva y una columna con default false.
--   · `agentCaptureEnabled` en false: el agente sigue sin poder registrar nada
--     hasta que se encienda desde el backoffice.
--   · Idempotente: IF NOT EXISTS y bloque DO para el tipo.

DO $$ BEGIN
  CREATE TYPE "AgentProposalStatus" AS ENUM ('COLLECTING', 'PENDING', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "platform_messaging_settings"
  ADD COLUMN IF NOT EXISTS "agentCaptureEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "agent_proposals" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT,
  "channel" "AssistantChannel" NOT NULL,
  "externalUserId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'capture',
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "preview" TEXT,
  "status" "AgentProposalStatus" NOT NULL DEFAULT 'COLLECTING',
  "confirmCode" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "resultRef" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_proposals_channel_externalUserId_status_idx"
  ON "agent_proposals"("channel", "externalUserId", "status");
CREATE INDEX IF NOT EXISTS "agent_proposals_channel_externalUserId_confirmCode_idx"
  ON "agent_proposals"("channel", "externalUserId", "confirmCode");
CREATE INDEX IF NOT EXISTS "agent_proposals_tenantId_status_idx"
  ON "agent_proposals"("tenantId", "status");
