-- Caja real: cuentas y bolsillos, cierres de caja, traslados y préstamos que hace
-- el negocio. Docs: docs/PLAN_CAJA_REAL_CIERRES_Y_CUENTAS.md
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA: tablas nuevas, columnas NULL sin default en `expenses` y
--     `capital_movements` (cambio de metadatos, no reescribe la tabla) y dos
--     valores nuevos de enum. No toca ni reinterpreta datos existentes.
--   · Sin cierres registrados, toda cifra de caja sigue dando exactamente igual.
--   · Idempotente: IF NOT EXISTS y bloques DO para tipos y constraints.
--   · ALTER TYPE ... ADD VALUE corre en transacción desde PostgreSQL 12; los
--     valores nuevos no se usan dentro de esta migración.

ALTER TYPE "CapitalMovementKind" ADD VALUE IF NOT EXISTS 'LOAN_OUT';
ALTER TYPE "CapitalMovementKind" ADD VALUE IF NOT EXISTS 'LOAN_OUT_REPAYMENT';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MoneyAccountType') THEN
    CREATE TYPE "MoneyAccountType" AS ENUM ('CASH', 'BANK', 'WALLET', 'OTHER');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "money_accounts" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "MoneyAccountType" NOT NULL DEFAULT 'OTHER',
  "defaultForMethods" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "money_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "money_accounts_tenantId_branchId_name_key"
  ON "money_accounts"("tenantId", "branchId", "name");
CREATE INDEX IF NOT EXISTS "money_accounts_tenantId_branchId_isActive_idx"
  ON "money_accounts"("tenantId", "branchId", "isActive");

CREATE TABLE IF NOT EXISTS "cash_closings" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "expectedTotalCOP" INTEGER NOT NULL,
  "countedTotalCOP" INTEGER NOT NULL,
  "note" TEXT,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "cash_closings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "cash_closings_tenantId_branchId_deletedAt_day_idx"
  ON "cash_closings"("tenantId", "branchId", "deletedAt", "day");

CREATE TABLE IF NOT EXISTS "cash_closing_lines" (
  "id" TEXT NOT NULL,
  "closingId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "countedCOP" INTEGER NOT NULL,
  "expectedSnapshotCOP" INTEGER,
  CONSTRAINT "cash_closing_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "cash_closing_lines_closingId_accountId_key"
  ON "cash_closing_lines"("closingId", "accountId");
CREATE INDEX IF NOT EXISTS "cash_closing_lines_accountId_idx"
  ON "cash_closing_lines"("accountId");

CREATE TABLE IF NOT EXISTS "money_transfers" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "fromAccountId" TEXT NOT NULL,
  "toAccountId" TEXT NOT NULL,
  "amountCOP" INTEGER NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "note" TEXT,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "money_transfers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "money_transfers_tenantId_branchId_deletedAt_occurredAt_idx"
  ON "money_transfers"("tenantId", "branchId", "deletedAt", "occurredAt");

ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "moneyAccountId" TEXT;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "paidOutsideBusiness" BOOLEAN;
ALTER TABLE "capital_movements" ADD COLUMN IF NOT EXISTS "moneyAccountId" TEXT;
ALTER TABLE "capital_movements" ADD COLUMN IF NOT EXISTS "paidOutsideBusiness" BOOLEAN;
ALTER TABLE "capital_movements" ADD COLUMN IF NOT EXISTS "counterpartyName" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'money_accounts_tenantId_fkey') THEN
    ALTER TABLE "money_accounts" ADD CONSTRAINT "money_accounts_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'money_accounts_branchId_fkey') THEN
    ALTER TABLE "money_accounts" ADD CONSTRAINT "money_accounts_branchId_fkey"
      FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_closing_lines_closingId_fkey') THEN
    ALTER TABLE "cash_closing_lines" ADD CONSTRAINT "cash_closing_lines_closingId_fkey"
      FOREIGN KEY ("closingId") REFERENCES "cash_closings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_closing_lines_accountId_fkey') THEN
    ALTER TABLE "cash_closing_lines" ADD CONSTRAINT "cash_closing_lines_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "money_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'money_transfers_fromAccountId_fkey') THEN
    ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_fromAccountId_fkey"
      FOREIGN KEY ("fromAccountId") REFERENCES "money_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'money_transfers_toAccountId_fkey') THEN
    ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_toAccountId_fkey"
      FOREIGN KEY ("toAccountId") REFERENCES "money_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_moneyAccountId_fkey') THEN
    ALTER TABLE "expenses" ADD CONSTRAINT "expenses_moneyAccountId_fkey"
      FOREIGN KEY ("moneyAccountId") REFERENCES "money_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'capital_movements_moneyAccountId_fkey') THEN
    ALTER TABLE "capital_movements" ADD CONSTRAINT "capital_movements_moneyAccountId_fkey"
      FOREIGN KEY ("moneyAccountId") REFERENCES "money_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
