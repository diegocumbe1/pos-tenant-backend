-- Retail: compromisos de pago en Por cobrar, con recordatorio por WhatsApp.
-- Ver docs/PLAN_RETAIL_AJUSTES_OCTUBRE_2026.md (pos-system) §6.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA: un enum, un valor a un enum existente y una tabla vacía con
--     sus índices. No toca ninguna venta ni ningún abono.
--   · `ADD VALUE IF NOT EXISTS` es idempotente y no se usa en esta misma
--     migración (Postgres no deja usar un valor recién agregado en la misma
--     transacción).
--   · Idempotente: bloques DO sobre el catálogo e IF NOT EXISTS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RetailCommitmentStatus') THEN
    CREATE TYPE "RetailCommitmentStatus" AS ENUM ('PENDING', 'FULFILLED', 'CANCELLED');
  END IF;
END $$;

ALTER TYPE "RetailSaleEventKind" ADD VALUE IF NOT EXISTS 'COMMITMENT';

CREATE TABLE IF NOT EXISTS "retail_payment_commitments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT,
    "saleIds" TEXT[],
    "dueOn" DATE NOT NULL,
    "amountCOP" INTEGER,
    "note" TEXT,
    "remindByWhatsapp" BOOLEAN NOT NULL DEFAULT true,
    "remindDaysBefore" INTEGER NOT NULL DEFAULT 1,
    "message" TEXT,
    "status" "RetailCommitmentStatus" NOT NULL DEFAULT 'PENDING',
    "remindedAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "retail_payment_commitments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "retail_payment_commitments_tenantId_branchId_status_dueOn_idx" ON "retail_payment_commitments"("tenantId", "branchId", "status", "dueOn");
CREATE INDEX IF NOT EXISTS "retail_payment_commitments_customerId_idx" ON "retail_payment_commitments"("customerId");
CREATE INDEX IF NOT EXISTS "retail_payment_commitments_saleIds_idx" ON "retail_payment_commitments" USING GIN ("saleIds");
