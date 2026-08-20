-- Entrega pendiente en la venta de mostrador.
--
-- Hasta ahora toda venta se daba por entregada en el acto, que es lo normal en
-- un mostrador. Pero hay casos —se encarga, se separa, se lleva después— en los
-- que la tienda ya cobró y todavía le debe mercancía al cliente, y eso no
-- quedaba anotado en ninguna parte.
--
-- ES INDEPENDIENTE DEL COBRO. La venta está cobrada, contabilizada y con el
-- stock descontado en los dos casos: la mercancía ya está apartada para ese
-- cliente, así que no puede seguir figurando como vendible. Lo único abierto es
-- la entrega, que es una tarea operativa, no un estado financiero.
--
-- El default DELIVERED clasifica todo el histórico como entregado, que es lo
-- que efectivamente pasó. Cambio aditivo: el backend anterior sigue funcionando
-- contra este esquema.

-- CreateEnum
CREATE TYPE "RetailDeliveryStatus" AS ENUM ('DELIVERED', 'PENDING');

-- AlterTable
ALTER TABLE "retail_sales" ADD COLUMN     "deliveryStatus" "RetailDeliveryStatus" NOT NULL DEFAULT 'DELIVERED',
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveryNote" TEXT;

-- CreateIndex
-- La bandeja de pendientes es una lectura constante y siempre filtra por
-- estado; sin índice recorrería todo el histórico de ventas.
CREATE INDEX "retail_sales_tenantId_branchId_deliveryStatus_soldAt_idx" ON "retail_sales"("tenantId", "branchId", "deliveryStatus", "soldAt");
