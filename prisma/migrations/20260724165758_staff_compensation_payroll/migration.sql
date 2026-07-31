-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('FIXED', 'FIXED_PLUS_BONUS', 'HOURLY', 'COMMISSION');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('PAYMENT', 'ADVANCE', 'LOAN', 'BONUS', 'DEDUCTION');

-- AlterEnum
ALTER TYPE "PayFrequency" ADD VALUE 'DAILY';

-- CreateTable
CREATE TABLE "staff_compensations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    "staffId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "contractType" "ContractType" NOT NULL,
    "payFrequency" "PayFrequency" NOT NULL,
    "baseAmount" INTEGER NOT NULL DEFAULT 0,
    "defaultBonuses" INTEGER,
    "hourlyRate" INTEGER,
    "expectedHoursPerPeriod" INTEGER,
    "commissionPercent" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_compensations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_compensation_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "contractType" "ContractType" NOT NULL,
    "payFrequency" "PayFrequency" NOT NULL,
    "baseAmount" INTEGER NOT NULL DEFAULT 0,
    "defaultBonuses" INTEGER,
    "hourlyRate" INTEGER,
    "expectedHoursPerPeriod" INTEGER,
    "commissionPercent" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_compensation_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_ledger_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    "staffId" TEXT NOT NULL,
    "staffName" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "note" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_compensations_tenantId_branchId_idx" ON "staff_compensations"("tenantId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_compensations_tenantId_staffId_key" ON "staff_compensations"("tenantId", "staffId");

-- CreateIndex
CREATE UNIQUE INDEX "role_compensation_templates_tenantId_role_key" ON "role_compensation_templates"("tenantId", "role");

-- CreateIndex
CREATE INDEX "staff_ledger_entries_tenantId_staffId_period_idx" ON "staff_ledger_entries"("tenantId", "staffId", "period");
