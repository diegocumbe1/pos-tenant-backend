-- Tipo de venta de mostrador: normal (PVP) o mayorista (escalones 6+/12+).
--
-- El precio mayorista ya existía por producto, pero la venta no guardaba con
-- cuál de las dos listas se cobró. Sin ese dato, finanzas no puede separar las
-- dos operaciones, y como el mayorista deja menos margen por unidad, un mes con
-- más ventas al por mayor se lee igual que un mes en el que se vendió peor.
--
-- El default RETAIL clasifica todo el histórico como venta normal, que es lo
-- que efectivamente fue: hasta ahora el POS solo cobraba a PVP. Cambio aditivo,
-- así que el backend viejo sigue funcionando contra este esquema.

-- CreateEnum
CREATE TYPE "RetailSaleType" AS ENUM ('RETAIL', 'WHOLESALE');

-- AlterTable
ALTER TABLE "retail_sales" ADD COLUMN     "saleType" "RetailSaleType" NOT NULL DEFAULT 'RETAIL';

-- CreateIndex
-- Finanzas filtra por tipo dentro de un rango de fechas; sin este índice ese
-- filtro recorre todas las ventas del período.
CREATE INDEX "retail_sales_tenantId_branchId_saleType_soldAt_idx" ON "retail_sales"("tenantId", "branchId", "saleType", "soldAt");
