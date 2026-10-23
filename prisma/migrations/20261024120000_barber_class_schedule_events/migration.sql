-- Histórico de los horarios de clase (cambios con fecha efectiva, archivar,
-- clases canceladas). Ver docs/PLAN_GIMNASIO_SOBRE_BARBERIA.md (pos-system).
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA una tabla vacía con su índice y su llave.
--   · Depende de 20261023150000_barber_plans_classes (corre antes por nombre).
--   · Idempotente: IF NOT EXISTS y bloque DO sobre el catálogo.

CREATE TABLE IF NOT EXISTS "barber_class_schedule_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" JSONB,
    "userId" TEXT,
    "userName" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "barber_class_schedule_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "barber_class_schedule_events_scheduleId_occurredAt_idx" ON "barber_class_schedule_events"("scheduleId", "occurredAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_class_schedule_events_scheduleId_fkey') THEN
    ALTER TABLE "barber_class_schedule_events" ADD CONSTRAINT "barber_class_schedule_events_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "barber_class_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
