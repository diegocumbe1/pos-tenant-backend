-- El flete que se le cobra al cliente, dentro de la venta.
--
-- POR QUÉ. El flete vive en el envío porque es del paquete y no de una venta en
-- particular: dos pedidos del mismo mayorista viajan en la misma caja con una
-- sola guía. Pero es plata que el cliente paga, y la bandeja de cobros lista
-- VENTAS mientras finanzas suma el `totalCOP` de las VENTAS. Un peso que no esté
-- dentro de una venta es un peso que nadie cobra y que no aparece en el ingreso.
--
-- El caso real: envío EN-000001 con 576.000 de mercancía y 8.400 de flete decía
-- "saldo por cobrar 328.500" cuando el cliente debía 336.900, y esos 8.400 no se
-- podían cobrar por ninguna pantalla.
--
-- Sigue siendo del envío —ahí se escribe y ahí se edita—; lo que cambia es que
-- el envío se lo carga a una de sus ventas sin cobrar, y ahí sí se ve.
--
--   totalCOP = subtotalCOP - discountCOP + shippingCOP
--
-- Default 0: una venta de mostrador no tiene flete, que es lo que fueron todas
-- las que ya existen.
ALTER TABLE "retail_sales" ADD COLUMN "shippingCOP" INTEGER NOT NULL DEFAULT 0;

-- Los envíos que YA existen también tienen que quedar cobrables: si no, el flete
-- de un paquete abierto seguiría invisible hasta que a alguien se le ocurra
-- editarlo. Misma regla que aplica el servicio de aquí en adelante: se le carga a
-- la ÚLTIMA venta sin cobrar del paquete (la última porque el flete se conoce al
-- despachar, cuando ya se metieron todas), y no se toca ninguna venta ya cobrada
-- —esa plata ya entró y reescribir su total cambiaría un ingreso del pasado—.
-- Los paquetes cancelados no le cobran flete a nadie.
CREATE TEMP TABLE "shipping_backfill" AS
SELECT DISTINCT ON (sh."id")
  s."id"                     AS "saleId",
  s."customerId"             AS "customerId",
  sh."shippingChargedCOP"    AS "amountCOP"
FROM "retail_shipments" sh
JOIN "retail_shipment_sales" ss ON ss."shipmentId" = sh."id"
JOIN "retail_sales" s ON s."id" = ss."saleId"
WHERE sh."status" <> 'CANCELLED'
  AND sh."shippingChargedCOP" > 0
  AND s."paymentStatus" = 'PENDING'
  AND s."status" <> 'VOIDED'
ORDER BY sh."id", ss."addedAt" DESC;

UPDATE "retail_sales" s
SET "shippingCOP" = b."amountCOP",
    "totalCOP"    = s."subtotalCOP" - s."discountCOP" + b."amountCOP"
FROM "shipping_backfill" b
WHERE s."id" = b."saleId";

-- Lo que el cliente lleva gastado incluye el flete que se le cobró.
UPDATE "retail_customers" c
SET "totalSpentCOP" = c."totalSpentCOP" + agg."amountCOP"
FROM (
  SELECT "customerId", SUM("amountCOP") AS "amountCOP"
  FROM "shipping_backfill"
  WHERE "customerId" IS NOT NULL
  GROUP BY "customerId"
) agg
WHERE c."id" = agg."customerId";

DROP TABLE "shipping_backfill";
