-- Modo soporte: un super-admin entra a un negocio con motivo y vencimiento, y
-- cada escritura que hace queda registrada. Historial solo para el backoffice.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA dos tablas vacías; no toca tablas existentes.
--   · support_sessions.tenantId sin FK: el historial sobrevive al borrado del tenant.
--   · Idempotente: IF NOT EXISTS y bloque DO sobre el catálogo.

CREATE TABLE IF NOT EXISTS "support_sessions" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tenantName" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedReason" TEXT,
    CONSTRAINT "support_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "support_session_actions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "body" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_session_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "support_sessions_actorUserId_endedAt_idx" ON "support_sessions"("actorUserId", "endedAt");
CREATE INDEX IF NOT EXISTS "support_sessions_tenantId_startedAt_idx" ON "support_sessions"("tenantId", "startedAt");
CREATE INDEX IF NOT EXISTS "support_session_actions_sessionId_createdAt_idx" ON "support_session_actions"("sessionId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'support_session_actions_sessionId_fkey'
  ) THEN
    ALTER TABLE "support_session_actions"
      ADD CONSTRAINT "support_session_actions_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "support_sessions"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
