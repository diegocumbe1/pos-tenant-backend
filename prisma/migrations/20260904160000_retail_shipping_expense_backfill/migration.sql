-- El costo de la guía como gasto, para los envíos que ya salieron.
--
-- POR QUÉ. Lo que cuesta mandar el paquete es plata que sale de la tienda y no
-- bajaba de ningún lado: `shippingCostCOP` no se usaba fuera del módulo de
-- envíos. En EN-000001 se pagaron 35.900 de guía y se le cobraron 8.400 al
-- cliente; esos 27.500 de diferencia dejaban la utilidad inflada.
--
-- De aquí en adelante lo escribe `RetailShipmentsService.syncShippingExpense` al
-- despachar. Esto es solo para los que ya estaban despachados.
--
-- El id se deriva del envío (`shipexp_<id>`) a propósito: es la misma clave que
-- usa el servicio, así que corregir después el costo de la guía actualiza este
-- mismo registro en vez de dejar dos gastos por el mismo flete. Por eso el
-- ON CONFLICT no hace nada: si ya existe, el servicio manda.
--
-- Solo los que SALIERON. Un borrador todavía no le ha pagado a la
-- transportadora y uno cancelado nunca lo hará. La fecha es la del despacho: el
-- gasto pesa el día en que el paquete salió, no hoy.
INSERT INTO "expenses" (
  "id", "tenantId", "branchId", "category", "concept",
  "amountCOP", "incurredAt", "note"
)
SELECT
  'shipexp_' || sh."id",
  sh."tenantId",
  sh."branchId",
  'SALES_SHIPPING',
  'Flete envío ' || sh."code" || COALESCE(' · ' || sh."carrier", ''),
  sh."shippingCostCOP",
  COALESCE(sh."sentAt", sh."createdAt"),
  CASE WHEN sh."trackingCode" IS NOT NULL
       THEN 'Guía ' || sh."trackingCode" END
FROM "retail_shipments" sh
WHERE sh."status" IN ('SENT', 'DELIVERED')
  AND sh."shippingCostCOP" > 0
ON CONFLICT ("id") DO NOTHING;
