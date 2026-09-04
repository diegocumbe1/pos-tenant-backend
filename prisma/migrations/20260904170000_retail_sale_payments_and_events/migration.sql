-- Abonos por venta e histórico de cambios.
--
-- POR QUÉ LOS ABONOS. `paymentStatus` solo sabía decir PAID o PENDING y el
-- mostrador no funciona así: el cliente manda 50.000 de un pedido de 300.000 y
-- después el resto. Sin abonos eso se anotaba bajándole el precio a la venta a
-- mano —el caso real del flete de EN-000001, cobrado en 8.400 porque el cliente
-- ya había mandado 27.500— y el histórico terminaba diciendo que se vendió más
-- barato en vez de que el cliente ya había abonado.
--
-- POR QUÉ EL HISTÓRICO. La nota de la venta es un campo de texto que se acumula,
-- sin autor ni hora. No responde "¿quién le cambió la fecha a esta venta?".
--
-- NINGUNO DE LOS DOS MUEVE FINANZAS. El ingreso se sigue contando por la venta
-- entera en su día (`soldAt`), exactamente como hasta ahora: los abonos
-- responden otra pregunta —cuánto de esa venta ya entró— que antes no tenía
-- dónde vivir. Cambiar el reconocimiento de ingreso a base caja es otra
-- decisión, y movería todos los números históricos.

-- PARTIAL: abonó una parte y queda saldo.
ALTER TYPE "RetailPaymentStatus" ADD VALUE IF NOT EXISTS 'PARTIAL' BEFORE 'PENDING';

-- Cuánto lleva abonado la venta. Se guarda aunque sea derivable: la bandeja de
-- cobros lista cientos de ventas y recalcular el saldo de cada una a punta de
-- agregados la vuelve lenta.
ALTER TABLE "retail_sales" ADD COLUMN "paidCOP" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "retail_sale_payments" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "branchId"      TEXT NOT NULL,
  "saleId"        TEXT NOT NULL,
  "amountCOP"     INTEGER NOT NULL,
  "method"        "RetailPaymentMethod" NOT NULL DEFAULT 'CASH',
  "paidAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note"          TEXT,
  "userId"        TEXT,
  "userName"      TEXT,
  "cashSessionId" TEXT,
  -- Un abono no se edita ni se borra: se anula y se registra otro. La plata
  -- entró un día y eso no se reescribe; el error también es parte del histórico.
  "voidedAt"      TIMESTAMP(3),
  "voidedReason"  TEXT,
  "voidedBy"      TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "retail_sale_payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "retail_sale_payments_tenantId_branchId_paidAt_idx"
  ON "retail_sale_payments" ("tenantId", "branchId", "paidAt");
CREATE INDEX "retail_sale_payments_saleId_idx"
  ON "retail_sale_payments" ("saleId");
ALTER TABLE "retail_sale_payments"
  ADD CONSTRAINT "retail_sale_payments_saleId_fkey"
  FOREIGN KEY ("saleId") REFERENCES "retail_sales"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "RetailSaleEventKind" AS ENUM (
  'CREATED',
  'PAYMENT',
  'PAYMENT_VOIDED',
  'DELIVERY',
  'RETURN',
  'DATE_CHANGED',
  'SHIPPING_CHARGED',
  'VOIDED',
  'NOTE'
);

CREATE TABLE "retail_sale_events" (
  "id"         TEXT NOT NULL,
  "tenantId"   TEXT NOT NULL,
  "branchId"   TEXT NOT NULL,
  "saleId"     TEXT NOT NULL,
  "kind"       "RetailSaleEventKind" NOT NULL,
  -- Frase lista para leer, congelada: el histórico de una venta vieja tiene que
  -- seguir diciendo lo que decía aunque la lógica cambie después.
  "summary"    TEXT NOT NULL,
  "note"       TEXT,
  "detail"     JSONB,
  "userId"     TEXT,
  "userName"   TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "retail_sale_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "retail_sale_events_saleId_occurredAt_idx"
  ON "retail_sale_events" ("saleId", "occurredAt");
CREATE INDEX "retail_sale_events_tenantId_branchId_occurredAt_idx"
  ON "retail_sale_events" ("tenantId", "branchId", "occurredAt");
ALTER TABLE "retail_sale_events"
  ADD CONSTRAINT "retail_sale_events_saleId_fkey"
  FOREIGN KEY ("saleId") REFERENCES "retail_sales"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
