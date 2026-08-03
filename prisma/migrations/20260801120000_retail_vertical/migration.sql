-- CreateEnum
CREATE TYPE "RetailStockMovementType" AS ENUM ('INITIAL', 'PURCHASE', 'SALE', 'RETURN', 'ADJUSTMENT', 'LOSS');

-- CreateEnum
CREATE TYPE "RetailSaleStatus" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "RetailPaymentMethod" AS ENUM ('CASH', 'CARD', 'TRANSFER', 'MIXED', 'OTHER');

-- CreateTable
CREATE TABLE "retail_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "retail_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retail_products" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "brand" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "costCOP" INTEGER NOT NULL DEFAULT 0,
    "priceCOP" INTEGER NOT NULL,
    "emoji" TEXT,
    "imageUrls" TEXT[],
    "trackStock" BOOLEAN NOT NULL DEFAULT true,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "minStock" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "attributes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "retail_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retail_stock_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "RetailStockMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "stockAfter" INTEGER NOT NULL,
    "unitCostCOP" INTEGER,
    "reason" TEXT,
    "reference" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retail_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retail_customers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "documentId" TEXT,
    "notes" TEXT,
    "totalSpentCOP" INTEGER NOT NULL DEFAULT 0,
    "salesCount" INTEGER NOT NULL DEFAULT 0,
    "lastPurchaseAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "retail_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retail_sales" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "customerId" TEXT,
    "userId" TEXT,
    "cashSessionId" TEXT,
    "status" "RetailSaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "subtotalCOP" INTEGER NOT NULL,
    "discountCOP" INTEGER NOT NULL DEFAULT 0,
    "totalCOP" INTEGER NOT NULL,
    "costCOP" INTEGER NOT NULL DEFAULT 0,
    "paymentMethod" "RetailPaymentMethod" NOT NULL DEFAULT 'CASH',
    "receivedCOP" INTEGER,
    "changeCOP" INTEGER,
    "note" TEXT,
    "soldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retail_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retail_sale_items" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPriceCOP" INTEGER NOT NULL,
    "unitCostCOP" INTEGER NOT NULL DEFAULT 0,
    "discountCOP" INTEGER NOT NULL DEFAULT 0,
    "totalCOP" INTEGER NOT NULL,

    CONSTRAINT "retail_sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "retail_categories_tenantId_branchId_deletedAt_idx" ON "retail_categories"("tenantId", "branchId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "retail_categories_tenantId_branchId_name_key" ON "retail_categories"("tenantId", "branchId", "name");

-- CreateIndex
CREATE INDEX "retail_products_tenantId_branchId_deletedAt_idx" ON "retail_products"("tenantId", "branchId", "deletedAt");

-- CreateIndex
CREATE INDEX "retail_products_categoryId_idx" ON "retail_products"("categoryId");

-- CreateIndex
CREATE INDEX "retail_products_tenantId_barcode_idx" ON "retail_products"("tenantId", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "retail_products_tenantId_branchId_sku_key" ON "retail_products"("tenantId", "branchId", "sku");

-- CreateIndex
CREATE INDEX "retail_stock_movements_tenantId_branchId_createdAt_idx" ON "retail_stock_movements"("tenantId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "retail_stock_movements_productId_createdAt_idx" ON "retail_stock_movements"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "retail_customers_tenantId_branchId_deletedAt_idx" ON "retail_customers"("tenantId", "branchId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "retail_customers_tenantId_phone_key" ON "retail_customers"("tenantId", "phone");

-- CreateIndex
CREATE INDEX "retail_sales_tenantId_branchId_soldAt_idx" ON "retail_sales"("tenantId", "branchId", "soldAt");

-- CreateIndex
CREATE INDEX "retail_sales_tenantId_branchId_status_soldAt_idx" ON "retail_sales"("tenantId", "branchId", "status", "soldAt");

-- CreateIndex
CREATE INDEX "retail_sales_customerId_idx" ON "retail_sales"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "retail_sales_tenantId_code_key" ON "retail_sales"("tenantId", "code");

-- CreateIndex
CREATE INDEX "retail_sale_items_saleId_idx" ON "retail_sale_items"("saleId");

-- CreateIndex
CREATE INDEX "retail_sale_items_productId_idx" ON "retail_sale_items"("productId");

-- AddForeignKey
ALTER TABLE "retail_categories" ADD CONSTRAINT "retail_categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_categories" ADD CONSTRAINT "retail_categories_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_products" ADD CONSTRAINT "retail_products_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_products" ADD CONSTRAINT "retail_products_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_products" ADD CONSTRAINT "retail_products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "retail_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_stock_movements" ADD CONSTRAINT "retail_stock_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_stock_movements" ADD CONSTRAINT "retail_stock_movements_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_stock_movements" ADD CONSTRAINT "retail_stock_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "retail_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_customers" ADD CONSTRAINT "retail_customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_customers" ADD CONSTRAINT "retail_customers_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_sales" ADD CONSTRAINT "retail_sales_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_sales" ADD CONSTRAINT "retail_sales_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_sales" ADD CONSTRAINT "retail_sales_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "retail_customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_sale_items" ADD CONSTRAINT "retail_sale_items_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "retail_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_sale_items" ADD CONSTRAINT "retail_sale_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "retail_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

