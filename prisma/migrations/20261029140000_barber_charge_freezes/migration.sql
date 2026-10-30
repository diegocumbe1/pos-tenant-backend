-- Congelar un plan con fechas: desde / hasta, motivo. Esos días el plan no
-- cubre asistencias y el mes de plan se corre (no se pierden sesiones).
-- Las congelaciones anteriores (solo `frozenDays`) quedan como estaban.
-- SEGURA: tabla nueva vacía, índice y FK. Idempotente.
CREATE TABLE IF NOT EXISTS "barber_charge_freezes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "days" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "barber_charge_freezes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "barber_charge_freezes_chargeId_idx" ON "barber_charge_freezes"("chargeId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barber_charge_freezes_chargeId_fkey') THEN
    ALTER TABLE "barber_charge_freezes" ADD CONSTRAINT "barber_charge_freezes_chargeId_fkey"
      FOREIGN KEY ("chargeId") REFERENCES "barber_charges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
