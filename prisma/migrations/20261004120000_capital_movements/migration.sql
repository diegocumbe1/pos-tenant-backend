-- Capital del dueño: aportes (con su origen), retiros y préstamos del negocio.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo CREA una tabla nueva y tres tipos nuevos. No altera ninguna tabla
--     existente ni toca datos.
--   · Idempotente: tipos y constraints protegidos con bloques DO, tabla e
--     índice con IF NOT EXISTS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CapitalMovementKind') THEN
    CREATE TYPE "CapitalMovementKind" AS ENUM ('INITIAL_CONTRIBUTION', 'CONTRIBUTION', 'PROFIT_WITHDRAWAL', 'CAPITAL_RETURN', 'LOAN_IN', 'LOAN_REPAYMENT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FundingSource') THEN
    CREATE TYPE "FundingSource" AS ENUM ('SAVINGS', 'FAMILY_LOAN', 'BANK_LOAN', 'PARTNER', 'OTHER');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InterestPeriod') THEN
    CREATE TYPE "InterestPeriod" AS ENUM ('MONTHLY', 'ANNUAL');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "capital_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "kind" "CapitalMovementKind" NOT NULL,
    "amountCOP" INTEGER NOT NULL,
    "inKind" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "fundingSource" "FundingSource",
    "fundingNote" TEXT,
    "interestRateBps" INTEGER,
    "interestPeriod" "InterestPeriod",
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "capital_movements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "capital_movements_tenantId_branchId_deletedAt_occurredAt_idx"
  ON "capital_movements"("tenantId", "branchId", "deletedAt", "occurredAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'capital_movements_tenantId_fkey') THEN
    ALTER TABLE "capital_movements" ADD CONSTRAINT "capital_movements_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'capital_movements_branchId_fkey') THEN
    ALTER TABLE "capital_movements" ADD CONSTRAINT "capital_movements_branchId_fkey"
      FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
