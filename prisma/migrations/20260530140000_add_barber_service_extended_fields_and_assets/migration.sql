-- AlterTable
ALTER TABLE "barber_services"
    ADD COLUMN "category" TEXT,
    ADD COLUMN "resultDuration" TEXT,
    ADD COLUMN "retouchPriceCOP" INTEGER,
    ADD COLUMN "retouchNote" TEXT,
    ADD COLUMN "primaryImageUrl" TEXT;

-- CreateIndex
CREATE INDEX "barber_services_category_idx" ON "barber_services"("category");

-- CreateTable
CREATE TABLE "barber_service_assets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alt" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'gallery',
    "fit" TEXT NOT NULL DEFAULT 'cover',
    "focalPoint" TEXT NOT NULL DEFAULT 'center',
    "showInPublicGallery" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "barber_service_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "barber_service_assets_tenantId_idx" ON "barber_service_assets"("tenantId");

-- CreateIndex
CREATE INDEX "barber_service_assets_serviceId_sortOrder_idx" ON "barber_service_assets"("serviceId", "sortOrder");

-- CreateIndex
CREATE INDEX "barber_service_assets_serviceId_kind_idx" ON "barber_service_assets"("serviceId", "kind");

-- AddForeignKey
ALTER TABLE "barber_service_assets"
    ADD CONSTRAINT "barber_service_assets_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "barber_services"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
