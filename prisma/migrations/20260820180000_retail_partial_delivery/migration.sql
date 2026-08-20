-- Entrega parcial: el stock sale al ENTREGAR, no al cobrar.
--
-- EL CASO. Un mayorista paga 11 unidades y se lleva 1 hoy; las otras 10 quedan
-- por entregar. Esas 10 siguen físicamente en la estantería, así que descontarlas
-- al cobrar dejaba el inventario mintiendo: el sistema decía 109 y al contar
-- había 119. Y al revés, se puede vender lo que todavía no ha llegado.
--
-- CÓMO QUEDA. Una venta marcada como pendiente no toca stock al cobrarse y
-- tampoco valida existencias (se puede vender lo que aún no está). Cada entrega
-- posterior es una fila de `retail_sale_deliveries` con su cantidad y su aroma,
-- y ESA es la que mueve el inventario y deja el movimiento en el kardex.
--
-- EL AROMA SE DEFINE AL ENTREGAR. Al cobrar, el mayorista compró "11 unidades",
-- no aromas concretos: obligar a elegirlos ahí sería inventar un dato. Por eso
-- `variantId` vive en la entrega y no solo en la línea de venta.
--
-- `deliveredQty` arranca en 0 por default, pero las ventas que YA existen se
-- entregaron en el acto — la migración las pone al día abajo, si no todo el
-- histórico figuraría como pendiente de entregar.

-- AlterTable
ALTER TABLE "retail_sale_items" ADD COLUMN     "deliveredQty" INTEGER NOT NULL DEFAULT 0;

-- Backfill: todo lo vendido hasta ahora salió del mostrador en el momento.
UPDATE "retail_sale_items" SET "deliveredQty" = "quantity";

-- CreateTable
CREATE TABLE "retail_sale_deliveries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "saleItemId" TEXT NOT NULL,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,
    "userId" TEXT,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retail_sale_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "retail_sale_deliveries_saleId_idx" ON "retail_sale_deliveries"("saleId");

-- CreateIndex
CREATE INDEX "retail_sale_deliveries_tenantId_branchId_deliveredAt_idx" ON "retail_sale_deliveries"("tenantId", "branchId", "deliveredAt");

-- AddForeignKey
ALTER TABLE "retail_sale_deliveries" ADD CONSTRAINT "retail_sale_deliveries_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "retail_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_sale_deliveries" ADD CONSTRAINT "retail_sale_deliveries_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "retail_sale_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL: si se borra el aroma, el registro de que salió mercancía sobrevive.
ALTER TABLE "retail_sale_deliveries" ADD CONSTRAINT "retail_sale_deliveries_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "retail_product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
