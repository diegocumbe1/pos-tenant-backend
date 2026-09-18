-- Cobro de suscripción + bitácora de eventos de la pasarela.
--
-- El cobro existe ANTES del pago: es contra lo que se concilia el webhook. El
-- SubscriptionPayment se sigue creando solo cuando el cobro queda aprobado, así
-- que la verdad contable no cambia de tabla.

-- Tarifa de la pasarela, para calcular la comisión (Wompi no la manda).
ALTER TABLE "platform_gateway_settings"
  ADD COLUMN "feePercentBps" INTEGER NOT NULL DEFAULT 265,
  ADD COLUMN "feeFixedCOP"   INTEGER NOT NULL DEFAULT 700,
  ADD COLUMN "feeTaxBps"     INTEGER NOT NULL DEFAULT 1900;

CREATE TABLE "subscription_charges" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "subscriptionId"    TEXT,
  "plan"              TEXT NOT NULL,
  "termMonths"        INTEGER NOT NULL DEFAULT 1,
  "periodStart"       TIMESTAMP(3) NOT NULL,
  "periodEnd"         TIMESTAMP(3) NOT NULL,
  "listAmount"        INTEGER,
  "discountAmount"    INTEGER NOT NULL DEFAULT 0,
  "discountReason"    TEXT,
  "amount"            INTEGER NOT NULL,
  "currency"          TEXT NOT NULL DEFAULT 'COP',
  "status"            TEXT NOT NULL DEFAULT 'pending',
  "statusDetail"      TEXT,
  "provider"          TEXT NOT NULL DEFAULT 'wompi',
  "reference"         TEXT NOT NULL,
  "checkoutUrl"       TEXT NOT NULL,
  "providerTxId"      TEXT,
  "paymentMethodType" TEXT,
  "gatewayFee"        INTEGER NOT NULL DEFAULT 0,
  "netSettled"        INTEGER,
  "paymentId"         TEXT,
  "expiresAt"         TIMESTAMP(3),
  "paidAt"            TIMESTAMP(3),
  "lastCheckedAt"     TIMESTAMP(3),
  "createdByUserId"   TEXT NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "subscription_charges_pkey" PRIMARY KEY ("id")
);

-- La referencia y el id de transacción son las dos llaves de idempotencia del
-- webhook: sin estos únicos, un reintento de Wompi duplicaría el pago.
CREATE UNIQUE INDEX "subscription_charges_reference_key" ON "subscription_charges"("reference");
CREATE UNIQUE INDEX "subscription_charges_providerTxId_key" ON "subscription_charges"("providerTxId");
CREATE INDEX "subscription_charges_tenantId_createdAt_idx" ON "subscription_charges"("tenantId", "createdAt");
CREATE INDEX "subscription_charges_status_idx" ON "subscription_charges"("status");

ALTER TABLE "subscription_charges"
  ADD CONSTRAINT "subscription_charges_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "subscription_charges"
  ADD CONSTRAINT "subscription_charges_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Bitácora cruda: guarda también lo rechazado por checksum, que es justo lo que
-- uno quiere poder mirar.
CREATE TABLE "gateway_events" (
  "id"            TEXT NOT NULL,
  "provider"      TEXT NOT NULL DEFAULT 'wompi',
  "eventType"     TEXT,
  "transactionId" TEXT,
  "reference"     TEXT,
  "status"        TEXT,
  "environment"   TEXT,
  "checksumOk"    BOOLEAN NOT NULL DEFAULT false,
  "handled"       BOOLEAN NOT NULL DEFAULT false,
  "outcome"       TEXT,
  "chargeId"      TEXT,
  "payload"       JSONB NOT NULL,
  "receivedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gateway_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "gateway_events_receivedAt_idx" ON "gateway_events"("receivedAt");
CREATE INDEX "gateway_events_transactionId_idx" ON "gateway_events"("transactionId");
