-- Cobro unificado del combo de verticales.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Crea dos tablas nuevas y agrega dos columnas NULLABLE sin default
--     (tenants."billingGroupId", subscription_charges."groupChargeId").
--   · Todos los negocios quedan con billingGroupId = NULL: ningún cobro, alerta ni
--     pantalla cambia para ellos.
--   · Sin backfill. Idempotente: IF NOT EXISTS y constraints dentro de DO $$.

CREATE TABLE IF NOT EXISTS "billing_groups" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "primaryTenantId" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "billing_group_charges" (
  "id" TEXT NOT NULL,
  "billingGroupId" TEXT NOT NULL,
  "termMonths" INTEGER NOT NULL DEFAULT 1,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "listAmount" INTEGER NOT NULL,
  "discountAmount" INTEGER NOT NULL DEFAULT 0,
  "amount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'COP',
  "breakdown" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "statusDetail" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'wompi',
  "reference" TEXT NOT NULL,
  "checkoutUrl" TEXT,
  "providerTxId" TEXT,
  "paymentMethodType" TEXT,
  "gatewayFee" INTEGER NOT NULL DEFAULT 0,
  "withheld" INTEGER NOT NULL DEFAULT 0,
  "netSettled" INTEGER,
  "feeMethod" TEXT,
  "expectedSettlementAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "lastCheckedAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_group_charges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "billing_group_charges_reference_key" ON "billing_group_charges"("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "billing_group_charges_providerTxId_key" ON "billing_group_charges"("providerTxId");
CREATE INDEX IF NOT EXISTS "billing_group_charges_billingGroupId_createdAt_idx" ON "billing_group_charges"("billingGroupId", "createdAt");
CREATE INDEX IF NOT EXISTS "billing_group_charges_status_idx" ON "billing_group_charges"("status");

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billingGroupId" TEXT;
CREATE INDEX IF NOT EXISTS "tenants_billingGroupId_idx" ON "tenants"("billingGroupId");

ALTER TABLE "subscription_charges" ADD COLUMN IF NOT EXISTS "groupChargeId" TEXT;
CREATE INDEX IF NOT EXISTS "subscription_charges_groupChargeId_idx" ON "subscription_charges"("groupChargeId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_group_charges_billingGroupId_fkey') THEN
    ALTER TABLE "billing_group_charges" ADD CONSTRAINT "billing_group_charges_billingGroupId_fkey"
      FOREIGN KEY ("billingGroupId") REFERENCES "billing_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_billingGroupId_fkey') THEN
    ALTER TABLE "tenants" ADD CONSTRAINT "tenants_billingGroupId_fkey"
      FOREIGN KEY ("billingGroupId") REFERENCES "billing_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscription_charges_groupChargeId_fkey') THEN
    ALTER TABLE "subscription_charges" ADD CONSTRAINT "subscription_charges_groupChargeId_fkey"
      FOREIGN KEY ("groupChargeId") REFERENCES "billing_group_charges"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
