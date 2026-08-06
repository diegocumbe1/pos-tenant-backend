-- Lista de pedidos al proveedor: el paso previo al catálogo y al inventario.
-- Tabla nueva, sin tocar nada existente salvo la FK opcional al producto.
-- CreateEnum
CREATE TYPE "RetailPurchaseStatus" AS ENUM ('PENDING', 'ORDERED', 'RECEIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "retail_purchase_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "productId" TEXT,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit" TEXT,
    "supplier" TEXT,
    "estimatedCostCOP" INTEGER,
    "note" TEXT,
    "status" "RetailPurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "isUrgent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "orderedById" TEXT,
    "receivedById" TEXT,
    "stockMovementId" TEXT,

    CONSTRAINT "retail_purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "retail_purchase_items_tenantId_branchId_status_deletedAt_idx" ON "retail_purchase_items"("tenantId", "branchId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "retail_purchase_items_tenantId_branchId_createdAt_idx" ON "retail_purchase_items"("tenantId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "retail_purchase_items_productId_idx" ON "retail_purchase_items"("productId");

-- AddForeignKey
ALTER TABLE "retail_purchase_items" ADD CONSTRAINT "retail_purchase_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_purchase_items" ADD CONSTRAINT "retail_purchase_items_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_purchase_items" ADD CONSTRAINT "retail_purchase_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "retail_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
