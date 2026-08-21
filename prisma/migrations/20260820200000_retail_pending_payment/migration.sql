-- Venta fiada: la mercancía sale, el dinero todavía no entra.
--
-- EL CASO. Se le entrega al cliente y se le cobra después. El stock SÍ se
-- descuenta (la mercancía ya no está), pero el ingreso NO se cuenta: contar
-- plata que no ha entrado infla las ventas del día y hace que la caja nunca
-- cuadre contra el reporte.
--
-- ES INDEPENDIENTE DE LA ENTREGA. Son dos ejes distintos y se combinan:
--
--   entregado + cobrado    → venta normal de mostrador
--   entregado + por cobrar → fiado
--   por entregar + cobrado → encargo pagado por adelantado
--   por entregar + por cobrar → encargo sin pagar
--
-- IMPACTO EN FINANZAS. El resumen de ventas deja fuera del ingreso, del costo y
-- del margen todo lo que esté en PENDING, y lo reporta aparte como "por cobrar".
-- Es base caja: la venta se cuenta cuando la plata entra. La venta sigue en el
-- histórico —no se esconde—, solo no suma al ingreso hasta que se marque pagada.
--
-- El default PAID clasifica todo el histórico como cobrado, que es lo que fue:
-- hasta ahora el mostrador solo cobraba de contado.

-- CreateEnum
CREATE TYPE "RetailPaymentStatus" AS ENUM ('PAID', 'PENDING');

-- AlterTable
ALTER TABLE "retail_sales" ADD COLUMN     "paymentStatus" "RetailPaymentStatus" NOT NULL DEFAULT 'PAID',
ADD COLUMN     "paidAt" TIMESTAMP(3);

-- Backfill: lo ya vendido se cobró en el momento, así que la fecha de pago es
-- la de la venta. Sin esto el histórico quedaría "pagado" pero sin saber cuándo.
UPDATE "retail_sales" SET "paidAt" = "soldAt" WHERE "paymentStatus" = 'PAID';

-- CreateIndex
CREATE INDEX "retail_sales_tenantId_branchId_paymentStatus_soldAt_idx" ON "retail_sales"("tenantId", "branchId", "paymentStatus", "soldAt");
