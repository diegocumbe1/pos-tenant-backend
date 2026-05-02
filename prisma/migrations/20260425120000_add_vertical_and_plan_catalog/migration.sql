-- CreateTable
CREATE TABLE "business_verticals" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_verticals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceCOP" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vertical_plans" (
    "verticalId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "vertical_plans_pkey" PRIMARY KEY ("verticalId","planId")
);

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "verticalId" TEXT;
ALTER TABLE "tenants" ADD COLUMN "planId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "business_verticals_code_key" ON "business_verticals"("code");
CREATE INDEX "business_verticals_isActive_idx" ON "business_verticals"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_code_key" ON "subscription_plans"("code");
CREATE INDEX "subscription_plans_isActive_idx" ON "subscription_plans"("isActive");

-- CreateIndex
CREATE INDEX "vertical_plans_planId_idx" ON "vertical_plans"("planId");
CREATE INDEX "vertical_plans_isActive_idx" ON "vertical_plans"("isActive");

-- CreateIndex
CREATE INDEX "tenants_verticalId_idx" ON "tenants"("verticalId");
CREATE INDEX "tenants_planId_idx" ON "tenants"("planId");

-- AddForeignKey
ALTER TABLE "vertical_plans" ADD CONSTRAINT "vertical_plans_verticalId_fkey" FOREIGN KEY ("verticalId") REFERENCES "business_verticals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vertical_plans" ADD CONSTRAINT "vertical_plans_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_verticalId_fkey" FOREIGN KEY ("verticalId") REFERENCES "business_verticals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed default public signup catalog
INSERT INTO "business_verticals" ("id", "code", "name", "isActive", "updatedAt")
VALUES
    ('vertical-restaurant', 'restaurant', 'Restaurante', true, CURRENT_TIMESTAMP),
    ('vertical-barber', 'barber', 'Barberia', true, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "subscription_plans" ("id", "code", "name", "priceCOP", "currency", "isActive", "updatedAt")
VALUES
    ('plan-basic', 'BASIC', 'Basic', 0, 'COP', true, CURRENT_TIMESTAMP),
    ('plan-pro', 'PRO', 'Pro', 99000, 'COP', true, CURRENT_TIMESTAMP),
    ('plan-premium', 'PREMIUM', 'Premium', 199000, 'COP', true, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "vertical_plans" ("verticalId", "planId", "isActive")
VALUES
    ('vertical-restaurant', 'plan-basic', true),
    ('vertical-restaurant', 'plan-pro', true),
    ('vertical-restaurant', 'plan-premium', true),
    ('vertical-barber', 'plan-basic', true),
    ('vertical-barber', 'plan-pro', true),
    ('vertical-barber', 'plan-premium', true)
ON CONFLICT ("verticalId", "planId") DO NOTHING;
