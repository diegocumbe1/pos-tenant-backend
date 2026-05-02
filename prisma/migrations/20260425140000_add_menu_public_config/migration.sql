-- CreateTable
CREATE TABLE "menu_public_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "showPrices" BOOLEAN NOT NULL DEFAULT true,
    "showDescription" BOOLEAN NOT NULL DEFAULT true,
    "showImages" BOOLEAN NOT NULL DEFAULT true,
    "showUnavailable" BOOLEAN NOT NULL DEFAULT false,
    "showFeaturedBadge" BOOLEAN NOT NULL DEFAULT true,
    "showRatings" BOOLEAN NOT NULL DEFAULT false,
    "showSavedCount" BOOLEAN NOT NULL DEFAULT false,
    "featuredProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categoryOrder" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "templateId" TEXT NOT NULL DEFAULT 'minimal',
    "primaryColor" TEXT NOT NULL DEFAULT '#16a34a',
    "accentColor" TEXT NOT NULL DEFAULT '#0ea5e9',
    "bannerText" TEXT,
    "logoMode" TEXT,
    "logoVariant" TEXT,
    "logoFit" TEXT,
    "logoEmoji" TEXT,
    "logoImageUrl" TEXT,
    "heroKicker" TEXT,
    "heroTitle" TEXT,
    "heroDescription" TEXT,
    "featuredTitle" TEXT,
    "featuredDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_public_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "menu_public_configs_tenantId_key" ON "menu_public_configs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "menu_public_configs_slug_key" ON "menu_public_configs"("slug");

-- CreateIndex
CREATE INDEX "menu_public_configs_slug_idx" ON "menu_public_configs"("slug");

-- AddForeignKey
ALTER TABLE "menu_public_configs" ADD CONSTRAINT "menu_public_configs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
