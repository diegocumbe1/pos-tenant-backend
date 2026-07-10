-- AlterTable
ALTER TABLE "ingredients" ADD COLUMN     "isPreparation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "yieldQuantity" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "preparation_components" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "preparationId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preparation_components_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "preparation_components_tenantId_idx" ON "preparation_components"("tenantId");

-- CreateIndex
CREATE INDEX "preparation_components_branchId_idx" ON "preparation_components"("branchId");

-- CreateIndex
CREATE INDEX "preparation_components_componentId_idx" ON "preparation_components"("componentId");

-- CreateIndex
CREATE UNIQUE INDEX "preparation_components_preparationId_componentId_key" ON "preparation_components"("preparationId", "componentId");

-- AddForeignKey
ALTER TABLE "preparation_components" ADD CONSTRAINT "preparation_components_preparationId_fkey" FOREIGN KEY ("preparationId") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preparation_components" ADD CONSTRAINT "preparation_components_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
