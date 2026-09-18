-- Editar los productos de una venta ya registrada, anular una devolución mal
-- hecha, y cobrar varias ventas con un solo pago.
--
-- Contexto: no había forma de corregir una venta cuando el cliente cambiaba de
-- opinión antes de pagar, así que se estaba usando la devolución como sustituto.
-- Eso deja escrito que se le devolvió una plata que nunca entró, y encima no
-- ajusta el saldo por cobrar.

-- 1) Hechos nuevos en el histórico de la venta.
ALTER TYPE "RetailSaleEventKind" ADD VALUE IF NOT EXISTS 'RETURN_VOIDED';
ALTER TYPE "RetailSaleEventKind" ADD VALUE IF NOT EXISTS 'ITEMS_EDITED';

-- 2) Anular una devolución. Mismo patrón que un abono anulado: no se borra, deja
--    de contar. Las existentes quedan con voidedAt NULL, o sea vigentes, que es
--    lo que son.
ALTER TABLE "retail_sale_returns" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(3);
ALTER TABLE "retail_sale_returns" ADD COLUMN IF NOT EXISTS "voidedReason" TEXT;
ALTER TABLE "retail_sale_returns" ADD COLUMN IF NOT EXISTS "voidedBy" TEXT;

-- 3) Pago que cubre varias ventas. Sigue habiendo un abono por venta; este id es
--    lo que los ata. NULL = pago normal de una sola venta, que es todo lo que
--    existe hasta hoy.
ALTER TABLE "retail_sale_payments" ADD COLUMN IF NOT EXISTS "groupId" TEXT;
CREATE INDEX IF NOT EXISTS "retail_sale_payments_groupId_idx" ON "retail_sale_payments"("groupId");
