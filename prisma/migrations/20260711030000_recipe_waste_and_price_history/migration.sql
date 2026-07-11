-- AlterTable: merma por línea de receta
ALTER TABLE "recipe_lines" ADD COLUMN "wastePercent" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable: histórico de precio/margen por producto
CREATE TABLE "product_price_history" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    "productId" TEXT NOT NULL,
    "priceCOP" INTEGER NOT NULL,
    "targetMarginPct" INTEGER NOT NULL,
    "changedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_price_history_tenantId_productId_createdAt_idx" ON "product_price_history"("tenantId", "productId", "createdAt");

-- AddForeignKey
ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
