-- Envíos: varias ventas en un mismo paquete, con su costo y sus soportes.
--
-- EL CASO. A un mayorista se le cobró un pedido el lunes y otro el jueves. Los
-- dos viajan en la misma caja, con una sola guía de $18.000 que a veces el
-- cliente paga y a veces se la come la tienda. Hoy no había dónde anotar eso:
-- `retail_sales.deliveryNote` es una nota suelta por venta, y el costo de la
-- guía no es de ninguna de las dos ventas — es del paquete.
--
-- CÓMO QUEDA. El envío es su propia entidad y las ventas se le cuelgan por
-- `retail_shipment_sales`. El paquete arranca en DRAFT (se está armando, no ha
-- salido nada), y al pasar a SENT es cuando se registran las entregas de todo lo
-- pendiente de esas ventas: ahí sale el stock y queda el kardex, por el mismo
-- camino que ya usaba la entrega parcial. DELIVERED lo confirma el cliente.
--
-- DOS PLATAS. `shippingCostCOP` (lo que cuesta la guía) y `shippingChargedCOP`
-- (lo que se le cobra al cliente por ella). Lo normal es que sean el mismo
-- número, y por eso el cobro se copia del costo cuando no se escribe; se separan
-- porque el caso que importa es el otro, el envío regalado o recargado. La
-- diferencia es lo que la tienda lleva puesto en envíos. Ninguno de los dos crea
-- ingreso ni gasto automático, igual que las compras a proveedor.
--
-- TRAZA FINA. `retail_sale_deliveries.shipmentId` dice en qué paquete salió cada
-- entrega. Una venta se puede repartir entre varios envíos (4 unidades hoy, 6 la
-- semana entrante), y sin esta columna no habría cómo saber qué llevó cada caja.
-- NULL = entrega de mostrador, que es todo el histórico anterior a este cambio.
--
-- SOPORTES. Foto de la guía, comprobante del flete o un PDF de la
-- transportadora, con descripción opcional. Se guarda también el `path` del
-- bucket y no solo la URL: sin él no se puede borrar el archivo al quitar el
-- soporte.
--
-- No hay backfill: los envíos empiezan a existir desde aquí. Las ventas
-- pendientes que ya están en la bandeja se pueden agrupar a mano cuando se
-- quiera, y las que se entreguen una por una siguen funcionando igual.

-- CreateEnum
CREATE TYPE "RetailShipmentStatus" AS ENUM ('DRAFT', 'SENT', 'DELIVERED', 'CANCELLED');

-- AlterTable
ALTER TABLE "retail_sale_deliveries" ADD COLUMN     "shipmentId" TEXT;

-- CreateEnum
CREATE TYPE "RetailShipmentAttachmentKind" AS ENUM ('IMAGE', 'PDF');

-- CreateTable
CREATE TABLE "retail_shipments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "RetailShipmentStatus" NOT NULL DEFAULT 'DRAFT',
    "customerId" TEXT,
    "recipientName" TEXT,
    "recipientPhone" TEXT,
    "address" TEXT,
    "carrier" TEXT,
    "trackingCode" TEXT,
    "shippingCostCOP" INTEGER NOT NULL DEFAULT 0,
    "shippingChargedCOP" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retail_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retail_shipment_sales" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retail_shipment_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retail_shipment_attachments" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "kind" "RetailShipmentAttachmentKind" NOT NULL,
    "url" TEXT NOT NULL,
    "path" TEXT,
    "name" TEXT,
    "sizeBytes" INTEGER,
    "description" TEXT,
    "userId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retail_shipment_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "retail_shipments_tenantId_code_key" ON "retail_shipments"("tenantId", "code");

-- CreateIndex
CREATE INDEX "retail_shipments_tenantId_branchId_status_createdAt_idx" ON "retail_shipments"("tenantId", "branchId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "retail_shipments_customerId_idx" ON "retail_shipments"("customerId");

-- CreateIndex
-- Una venta no puede estar dos veces en el MISMO paquete. Que no esté en dos
-- paquetes abiertos a la vez es otra regla, y esa la valida el servicio: un
-- envío cancelado tiene que dejar volver a despachar la venta en otro paquete.
CREATE UNIQUE INDEX "retail_shipment_sales_shipmentId_saleId_key" ON "retail_shipment_sales"("shipmentId", "saleId");

-- CreateIndex
CREATE INDEX "retail_shipment_sales_saleId_idx" ON "retail_shipment_sales"("saleId");

-- CreateIndex
CREATE INDEX "retail_shipment_attachments_shipmentId_idx" ON "retail_shipment_attachments"("shipmentId");

-- CreateIndex
CREATE INDEX "retail_sale_deliveries_shipmentId_idx" ON "retail_sale_deliveries"("shipmentId");

-- AddForeignKey
-- SET NULL: si se borra el envío, la entrega y su kardex siguen siendo ciertos.
ALTER TABLE "retail_sale_deliveries" ADD CONSTRAINT "retail_sale_deliveries_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "retail_shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL: si se borra el cliente, el registro del envío sobrevive.
ALTER TABLE "retail_shipments" ADD CONSTRAINT "retail_shipments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "retail_customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_shipment_sales" ADD CONSTRAINT "retail_shipment_sales_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "retail_shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_shipment_sales" ADD CONSTRAINT "retail_shipment_sales_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "retail_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_shipment_attachments" ADD CONSTRAINT "retail_shipment_attachments_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "retail_shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
