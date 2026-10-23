-- Canchas: reserva fija semanal ("equipo X, martes 20:00, cancha 2"). Cada
-- semana genera una reserva normal que se cobra el día.
-- Ver docs/PLAN_GIMNASIO_SOBRE_BARBERIA.md (pos-system).
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA una tabla vacía y una columna nula en barber_appointments.
--   · Borrar una reserva fija deja sus reservas pasadas (ON DELETE SET NULL).
--   · Idempotente: IF NOT EXISTS y bloque DO sobre el catálogo.
--   · Sin drift ajeno (el diff proponía tocar retail_products e índices
--     ajenos; se dejaron fuera).

CREATE TABLE IF NOT EXISTS "barber_recurring_bookings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "staffId" TEXT,
    "weekday" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "priceCOP" INTEGER NOT NULL,
    "activeFrom" DATE NOT NULL,
    "activeUntil" DATE,
    "generatedUntil" DATE,
    "notes" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "barber_recurring_bookings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "barber_appointments" ADD COLUMN IF NOT EXISTS "recurringBookingId" TEXT;

CREATE INDEX IF NOT EXISTS "barber_recurring_bookings_tenantId_branchId_idx" ON "barber_recurring_bookings"("tenantId", "branchId");
CREATE INDEX IF NOT EXISTS "barber_recurring_bookings_branchId_generatedUntil_idx" ON "barber_recurring_bookings"("branchId", "generatedUntil");
CREATE INDEX IF NOT EXISTS "barber_appointments_recurringBookingId_idx" ON "barber_appointments"("recurringBookingId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_appointments_recurringBookingId_fkey') THEN
    ALTER TABLE "barber_appointments" ADD CONSTRAINT "barber_appointments_recurringBookingId_fkey" FOREIGN KEY ("recurringBookingId") REFERENCES "barber_recurring_bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_recurring_bookings_customerId_fkey') THEN
    ALTER TABLE "barber_recurring_bookings" ADD CONSTRAINT "barber_recurring_bookings_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "barber_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_recurring_bookings_serviceId_fkey') THEN
    ALTER TABLE "barber_recurring_bookings" ADD CONSTRAINT "barber_recurring_bookings_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "barber_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_recurring_bookings_staffId_fkey') THEN
    ALTER TABLE "barber_recurring_bookings" ADD CONSTRAINT "barber_recurring_bookings_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "barber_staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
