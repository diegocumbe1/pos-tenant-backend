-- Google Calendar: conexiones (por especialista o del negocio) y el enlace
-- evento de Google ↔ cita/clase. Ver docs/PLAN_GOOGLE_CALENDAR.md (frontend).
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA dos tablas vacías; no toca tablas existentes.
--   · Idempotente: IF NOT EXISTS y bloques DO sobre el catálogo.

CREATE TABLE IF NOT EXISTS "google_calendar_connections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "staffId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "googleEmail" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "reminderMinutes" INTEGER[] DEFAULT ARRAY[30]::INTEGER[],
    "includePhone" BOOLEAN NOT NULL DEFAULT false,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "needsReauth" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "google_calendar_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "google_calendar_event_links" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "googleEventId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "google_calendar_event_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "google_calendar_connections_staffId_key" ON "google_calendar_connections"("staffId");
CREATE UNIQUE INDEX IF NOT EXISTS "google_calendar_connections_scopeKey_key" ON "google_calendar_connections"("scopeKey");
CREATE INDEX IF NOT EXISTS "google_calendar_connections_tenantId_branchId_idx" ON "google_calendar_connections"("tenantId", "branchId");
CREATE UNIQUE INDEX IF NOT EXISTS "google_calendar_event_links_connectionId_ref_key" ON "google_calendar_event_links"("connectionId", "ref");
CREATE INDEX IF NOT EXISTS "google_calendar_event_links_connectionId_startsAt_idx" ON "google_calendar_event_links"("connectionId", "startsAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'google_calendar_connections_staffId_fkey'
  ) THEN
    ALTER TABLE "google_calendar_connections"
      ADD CONSTRAINT "google_calendar_connections_staffId_fkey"
      FOREIGN KEY ("staffId") REFERENCES "barber_staff"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'google_calendar_event_links_connectionId_fkey'
  ) THEN
    ALTER TABLE "google_calendar_event_links"
      ADD CONSTRAINT "google_calendar_event_links_connectionId_fkey"
      FOREIGN KEY ("connectionId") REFERENCES "google_calendar_connections"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
