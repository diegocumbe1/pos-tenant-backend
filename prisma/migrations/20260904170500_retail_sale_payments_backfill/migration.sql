-- Las ventas que ya existían, dentro del mundo de los abonos.
--
-- Va en su propio archivo y no junto a la creación de las tablas porque el valor
-- 'PARTIAL' del enum no se puede usar en la misma transacción en que se agrega.
-- Aquí no hace falta —una venta vieja o estaba cobrada o no— pero separar los
-- dos pasos deja el orden claro para la próxima vez.
--
-- IDS DERIVADOS. Cada fila lleva un id calculado a partir de la venta
-- ('paybf_<saleId>'), así que volver a correr esto no duplica nada. El
-- ON CONFLICT es el seguro.

-- Una venta que figura cobrada tuvo un pago: se registra como tal para que el
-- saldo salga en 0 y no como "no ha abonado nada". El medio y la fecha son los
-- que la venta ya tenía anotados; no se inventa ninguno.
INSERT INTO "retail_sale_payments" (
  "id", "tenantId", "branchId", "saleId",
  "amountCOP", "method", "paidAt", "note"
)
SELECT
  'paybf_' || s."id",
  s."tenantId",
  s."branchId",
  s."id",
  s."totalCOP",
  s."paymentMethod",
  COALESCE(s."paidAt", s."soldAt"),
  'Cobro registrado antes de que existieran los abonos'
FROM "retail_sales" s
WHERE s."paymentStatus" = 'PAID'
  AND s."totalCOP" > 0
ON CONFLICT ("id") DO NOTHING;

UPDATE "retail_sales" s
SET "paidCOP" = s."totalCOP"
WHERE s."paymentStatus" = 'PAID';

-- El histórico arranca con lo que se sabe de cada venta: que se registró, y —si
-- estaba cobrada— que entró la plata. Sin esto, abrir una venta vieja mostraría
-- un histórico vacío, que se lee como "aquí no ha pasado nada" en vez de "esto
-- es anterior al histórico".
--
-- El resumen no lleva montos: formatear pesos en SQL saldría distinto a como los
-- escribe la aplicación, y un histórico que se contradice consigo mismo es peor
-- que uno escueto. Los números van en `detail`.
INSERT INTO "retail_sale_events" (
  "id", "tenantId", "branchId", "saleId",
  "kind", "summary", "detail", "occurredAt"
)
SELECT
  'evbf_created_' || s."id",
  s."tenantId",
  s."branchId",
  s."id",
  'CREATED',
  'Venta registrada',
  jsonb_build_object(
    'totalCOP', s."totalCOP",
    'backfilled', true
  ),
  s."soldAt"
FROM "retail_sales" s
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "retail_sale_events" (
  "id", "tenantId", "branchId", "saleId",
  "kind", "summary", "detail", "occurredAt"
)
SELECT
  'evbf_paid_' || s."id",
  s."tenantId",
  s."branchId",
  s."id",
  'PAYMENT',
  'Cobro registrado antes de que existieran los abonos',
  jsonb_build_object(
    'amountCOP', s."totalCOP",
    'method', s."paymentMethod",
    'backfilled', true
  ),
  COALESCE(s."paidAt", s."soldAt")
FROM "retail_sales" s
WHERE s."paymentStatus" = 'PAID'
  AND s."totalCOP" > 0
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "retail_sale_events" (
  "id", "tenantId", "branchId", "saleId",
  "kind", "summary", "detail", "occurredAt"
)
SELECT
  'evbf_voided_' || s."id",
  s."tenantId",
  s."branchId",
  s."id",
  'VOIDED',
  COALESCE('Venta anulada: ' || s."voidedReason", 'Venta anulada'),
  jsonb_build_object('backfilled', true),
  COALESCE(s."voidedAt", s."soldAt")
FROM "retail_sales" s
WHERE s."status" = 'VOIDED'
ON CONFLICT ("id") DO NOTHING;
