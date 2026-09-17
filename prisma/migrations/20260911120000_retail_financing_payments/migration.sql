-- Financiación en el punto de venta (Sistecrédito, Addi) — Fase 1.
--
-- Plan: docs/PLAN_PAGOS_FINANCIACION_SISTECREDITO_ADDI.md (repo del frontend).
--
-- EL CAMBIO QUE HAY QUE MIRAR DOS VECES es `settledAt` en los abonos: a partir
-- de esta migración el ingreso de retail se cuenta por la fecha en que la plata
-- ENTRÓ, no por la fecha en que el cliente pagó. Para todo lo que ya existe son
-- la misma fecha —en efectivo y transferencia la plata entra en el acto—, así
-- que el backfill deja el histórico EXACTAMENTE igual. La diferencia aparece
-- solo con financiación, que es el punto: la venta es del 10 y la plata del 18.

-- ─── Enums ────────────────────────────────────────────────────────────────────

ALTER TYPE "RetailPaymentMethod" ADD VALUE 'FINANCING';

CREATE TYPE "FinancingStatus" AS ENUM (
    'PENDING_APPROVAL',
    'APPROVED',
    'REJECTED',
    'SETTLED',
    'REVERSED'
);

-- ─── Convenios y sus términos fechados ────────────────────────────────────────

CREATE TABLE "financing_providers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financing_providers_pkey" PRIMARY KEY ("id")
);

-- Un solo convenio por código y sede: dos "addi" en la misma tienda serían dos
-- comisiones distintas para el mismo acuerdo.
CREATE UNIQUE INDEX "financing_providers_branchId_code_key"
    ON "financing_providers"("branchId", "code");

CREATE INDEX "financing_providers_tenantId_branchId_isActive_idx"
    ON "financing_providers"("tenantId", "branchId", "isActive");

-- APPEND-ONLY, igual que plan_prices: renegociar escribe una fila nueva, no
-- edita la anterior. Es lo que permite responder qué comisión regía en marzo.
CREATE TABLE "financing_provider_terms" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "settlementDays" INTEGER NOT NULL,
    "minAmountCOP" INTEGER NOT NULL DEFAULT 0,
    "feeHasVat" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financing_provider_terms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "financing_provider_terms_providerId_effectiveFrom_idx"
    ON "financing_provider_terms"("providerId", "effectiveFrom");

ALTER TABLE "financing_provider_terms"
    ADD CONSTRAINT "financing_provider_terms_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "financing_providers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Giros del financiador ────────────────────────────────────────────────────

CREATE TABLE "financing_settlements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "expectedCOP" INTEGER NOT NULL,
    "receivedCOP" INTEGER NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financing_settlements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "financing_settlements_tenantId_branchId_settledAt_idx"
    ON "financing_settlements"("tenantId", "branchId", "settledAt");

CREATE INDEX "financing_settlements_providerId_settledAt_idx"
    ON "financing_settlements"("providerId", "settledAt");

ALTER TABLE "financing_settlements"
    ADD CONSTRAINT "financing_settlements_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "financing_providers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Términos congelados en la venta ──────────────────────────────────────────

ALTER TABLE "retail_sales"
    ADD COLUMN "financingProviderId" TEXT,
    ADD COLUMN "financingProviderName" TEXT,
    ADD COLUMN "financingFeeBps" INTEGER,
    ADD COLUMN "financingFeeCOP" INTEGER,
    ADD COLUMN "financingAuthCode" TEXT,
    ADD COLUMN "financingStatus" "FinancingStatus";

ALTER TABLE "retail_sales"
    ADD CONSTRAINT "retail_sales_financingProviderId_fkey"
    FOREIGN KEY ("financingProviderId") REFERENCES "financing_providers"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Términos congelados y fecha de caja en el abono ──────────────────────────

ALTER TABLE "retail_sale_payments"
    ADD COLUMN "settledAt" TIMESTAMP(3),
    ADD COLUMN "financingProviderId" TEXT,
    ADD COLUMN "financingProviderName" TEXT,
    ADD COLUMN "financingFeeBps" INTEGER,
    ADD COLUMN "financingFeeCOP" INTEGER,
    ADD COLUMN "financingAuthCode" TEXT,
    ADD COLUMN "financingSettlementId" TEXT;

-- EL BACKFILL QUE DEJA EL HISTÓRICO INTACTO.
-- Todo lo cobrado hasta hoy entró el mismo día en que el cliente pagó, porque
-- no existía ningún medio diferido. Copiar `paidAt` no es una aproximación: es
-- literalmente lo que pasó. Sin esto, toda la plata histórica quedaría con
-- settledAt NULL y las pantallas de finanzas mostrarían cero.
UPDATE "retail_sale_payments" SET "settledAt" = "paidAt" WHERE "settledAt" IS NULL;

CREATE INDEX "retail_sale_payments_tenantId_branchId_settledAt_idx"
    ON "retail_sale_payments"("tenantId", "branchId", "settledAt");

CREATE INDEX "retail_sale_payments_tenantId_branchId_financingProviderId_settledAt_idx"
    ON "retail_sale_payments"("tenantId", "branchId", "financingProviderId", "settledAt");

ALTER TABLE "retail_sale_payments"
    ADD CONSTRAINT "retail_sale_payments_financingProviderId_fkey"
    FOREIGN KEY ("financingProviderId") REFERENCES "financing_providers"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "retail_sale_payments"
    ADD CONSTRAINT "retail_sale_payments_financingSettlementId_fkey"
    FOREIGN KEY ("financingSettlementId") REFERENCES "financing_settlements"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Origen del gasto ─────────────────────────────────────────────────────────
-- Para poder ir del gasto a su venta y no solo al revés (ver el comentario del
-- modelo Expense). Aprovecha y le pone origen a los fletes que ya existen.

ALTER TABLE "expenses"
    ADD COLUMN "sourceType" TEXT,
    ADD COLUMN "sourceId" TEXT;

CREATE INDEX "expenses_tenantId_sourceType_sourceId_idx"
    ON "expenses"("tenantId", "sourceType", "sourceId");

UPDATE "expenses"
   SET "sourceType" = 'RETAIL_SHIPMENT',
       "sourceId" = substring("id" from 9)
 WHERE "id" LIKE 'shipexp\_%' AND "sourceType" IS NULL;
