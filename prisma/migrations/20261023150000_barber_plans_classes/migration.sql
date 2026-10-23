-- Barbería / gimnasio: planes y paquetes (Fase 2) y clases con cupo (Fase 3).
-- Ver docs/PLAN_GIMNASIO_SOBRE_BARBERIA.md (pos-system).
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA columnas con default o nulas y tablas vacías. Los servicios
--     existentes quedan como kind = 'SERVICE' y capacity = 1, que es exactamente
--     cómo se comportan hoy.
--   · Depende de 20261023120000_barber_charges_payments (corre antes por nombre).
--   · Las llaves nuevas a citas, cobros y staff son ON DELETE SET NULL: borrar una
--     clase o un cobro no se lleva el historial de citas.
--   · Idempotente: IF NOT EXISTS y bloques DO sobre el catálogo.
--   · Sin drift ajeno: el diff también proponía tocar `retail_products` y
--     renombrar dos índices ajenos; se dejaron fuera a propósito.

-- ─── Servicio: plan, paquete o clase ────────────────────────────────────────
ALTER TABLE "barber_services" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'SERVICE';
ALTER TABLE "barber_services" ADD COLUMN IF NOT EXISTS "validityDays" INTEGER;
ALTER TABLE "barber_services" ADD COLUMN IF NOT EXISTS "sessionsIncluded" INTEGER;
ALTER TABLE "barber_services" ADD COLUMN IF NOT EXISTS "capacity" INTEGER NOT NULL DEFAULT 1;

-- ─── Cobro: sesiones del paquete y días congelados ──────────────────────────
ALTER TABLE "barber_charges" ADD COLUMN IF NOT EXISTS "sessionsTotal" INTEGER;
ALTER TABLE "barber_charges" ADD COLUMN IF NOT EXISTS "frozenDays" INTEGER NOT NULL DEFAULT 0;

-- ─── Clases ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "barber_class_schedules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "staffId" TEXT,
    "weekday" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "activeFrom" DATE NOT NULL,
    "activeUntil" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "barber_class_schedules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "barber_class_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "serviceId" TEXT NOT NULL,
    "staffId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "barber_class_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "barber_class_enrollments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "activeFrom" DATE NOT NULL,
    "activeUntil" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "barber_class_enrollments_pkey" PRIMARY KEY ("id")
);

-- ─── Cita: clase a la que pertenece y plan que la cubre ─────────────────────
ALTER TABLE "barber_appointments" ADD COLUMN IF NOT EXISTS "classSessionId" TEXT;
ALTER TABLE "barber_appointments" ADD COLUMN IF NOT EXISTS "coveredByChargeId" TEXT;

CREATE INDEX IF NOT EXISTS "barber_class_schedules_tenantId_branchId_isActive_idx" ON "barber_class_schedules"("tenantId", "branchId", "isActive");
CREATE INDEX IF NOT EXISTS "barber_class_sessions_tenantId_branchId_startsAt_idx" ON "barber_class_sessions"("tenantId", "branchId", "startsAt");
CREATE UNIQUE INDEX IF NOT EXISTS "barber_class_sessions_scheduleId_startsAt_key" ON "barber_class_sessions"("scheduleId", "startsAt");
CREATE INDEX IF NOT EXISTS "barber_class_enrollments_scheduleId_idx" ON "barber_class_enrollments"("scheduleId");
CREATE INDEX IF NOT EXISTS "barber_class_enrollments_customerId_idx" ON "barber_class_enrollments"("customerId");
CREATE INDEX IF NOT EXISTS "barber_appointments_classSessionId_idx" ON "barber_appointments"("classSessionId");
CREATE INDEX IF NOT EXISTS "barber_appointments_coveredByChargeId_idx" ON "barber_appointments"("coveredByChargeId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_appointments_classSessionId_fkey') THEN
    ALTER TABLE "barber_appointments" ADD CONSTRAINT "barber_appointments_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "barber_class_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_appointments_coveredByChargeId_fkey') THEN
    ALTER TABLE "barber_appointments" ADD CONSTRAINT "barber_appointments_coveredByChargeId_fkey" FOREIGN KEY ("coveredByChargeId") REFERENCES "barber_charges"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_class_schedules_serviceId_fkey') THEN
    ALTER TABLE "barber_class_schedules" ADD CONSTRAINT "barber_class_schedules_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "barber_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_class_schedules_staffId_fkey') THEN
    ALTER TABLE "barber_class_schedules" ADD CONSTRAINT "barber_class_schedules_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "barber_staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_class_sessions_scheduleId_fkey') THEN
    ALTER TABLE "barber_class_sessions" ADD CONSTRAINT "barber_class_sessions_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "barber_class_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_class_sessions_serviceId_fkey') THEN
    ALTER TABLE "barber_class_sessions" ADD CONSTRAINT "barber_class_sessions_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "barber_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_class_sessions_staffId_fkey') THEN
    ALTER TABLE "barber_class_sessions" ADD CONSTRAINT "barber_class_sessions_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "barber_staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_class_enrollments_scheduleId_fkey') THEN
    ALTER TABLE "barber_class_enrollments" ADD CONSTRAINT "barber_class_enrollments_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "barber_class_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_class_enrollments_customerId_fkey') THEN
    ALTER TABLE "barber_class_enrollments" ADD CONSTRAINT "barber_class_enrollments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "barber_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
