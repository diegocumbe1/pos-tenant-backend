-- Barbería / gimnasio: cobros independientes de la cita y sus pagos (abonos).
-- Ver docs/PLAN_GIMNASIO_SOBRE_BARBERIA.md (pos-system) §Fase 1.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA dos tablas vacías con sus índices y llaves. No toca ninguna
--     cita, cliente ni servicio existente.
--   · Las llaves a citas, clientes y servicios son ON DELETE SET NULL: borrar
--     una cita nunca se lleva la plata que ya entró.
--   · Idempotente: IF NOT EXISTS y bloques DO sobre el catálogo.
--   · Sin drift ajeno: el diff también proponía tocar `retail_products`, que no
--     es de este cambio y se dejó fuera a propósito.

CREATE TABLE IF NOT EXISTS "barber_charges" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT,
    "appointmentId" TEXT,
    "serviceId" TEXT,
    "concept" TEXT NOT NULL,
    "totalCOP" INTEGER NOT NULL,
    "chargedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "startsOn" DATE,
    "endsOn" DATE,
    "dueOn" DATE,
    "userId" TEXT,
    "userName" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedReason" TEXT,
    "voidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "barber_charges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "barber_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "amountCOP" INTEGER NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'CASH',
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedReason" TEXT,
    "voidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "barber_payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "barber_charges_tenantId_branchId_chargedAt_idx" ON "barber_charges"("tenantId", "branchId", "chargedAt");
CREATE INDEX IF NOT EXISTS "barber_charges_tenantId_branchId_dueOn_idx" ON "barber_charges"("tenantId", "branchId", "dueOn");
CREATE INDEX IF NOT EXISTS "barber_charges_customerId_idx" ON "barber_charges"("customerId");
CREATE INDEX IF NOT EXISTS "barber_charges_appointmentId_idx" ON "barber_charges"("appointmentId");
CREATE INDEX IF NOT EXISTS "barber_payments_tenantId_branchId_paidAt_idx" ON "barber_payments"("tenantId", "branchId", "paidAt");
CREATE INDEX IF NOT EXISTS "barber_payments_chargeId_idx" ON "barber_payments"("chargeId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_charges_customerId_fkey') THEN
    ALTER TABLE "barber_charges" ADD CONSTRAINT "barber_charges_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "barber_customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_charges_appointmentId_fkey') THEN
    ALTER TABLE "barber_charges" ADD CONSTRAINT "barber_charges_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "barber_appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_charges_serviceId_fkey') THEN
    ALTER TABLE "barber_charges" ADD CONSTRAINT "barber_charges_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "barber_services"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_payments_chargeId_fkey') THEN
    ALTER TABLE "barber_payments" ADD CONSTRAINT "barber_payments_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "barber_charges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
