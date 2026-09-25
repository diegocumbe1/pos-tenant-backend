-- Tarifas por medio de pago + retenciones, y el desglose real de cada cobro.
--
-- Motivo: la comisión no es lo único que descuentan. Sobre TARJETA el banco
-- adquirente practica retefuente (1,5%), reteICA (0,2%) y reteIVA (15% del IVA)
-- al liquidar. Esas retenciones NO son costo —son anticipo de impuestos— así
-- que se guardan aparte para no inflar el gasto.

-- Append-only, igual que plan_prices: cambiar una tarifa es insertar una fila.
CREATE TABLE "platform_gateway_fees" (
  "id"             TEXT NOT NULL,
  "method"         TEXT NOT NULL,
  "percentBps"     INTEGER NOT NULL DEFAULT 0,
  "fixedCOP"       INTEGER NOT NULL DEFAULT 0,
  "taxBps"         INTEGER NOT NULL DEFAULT 1900,
  "retefuenteBps"  INTEGER NOT NULL DEFAULT 0,
  "reteIcaBps"     INTEGER NOT NULL DEFAULT 0,
  "reteIvaBps"     INTEGER NOT NULL DEFAULT 0,
  "settlementDays" INTEGER NOT NULL DEFAULT 1,
  "effectiveFrom"  TIMESTAMP(3) NOT NULL,
  "note"           TEXT,
  "createdBy"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_gateway_fees_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_gateway_fees_method_effectiveFrom_idx"
  ON "platform_gateway_fees"("method", "effectiveFrom");

ALTER TABLE "subscription_charges"
  ADD COLUMN "withheld"             INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "feeMethod"            TEXT,
  ADD COLUMN "expectedSettlementAt" TIMESTAMP(3);
