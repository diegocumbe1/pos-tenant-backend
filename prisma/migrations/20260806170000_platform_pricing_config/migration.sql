-- CreateTable
CREATE TABLE "platform_pricing_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "usdToCopRate" INTEGER NOT NULL DEFAULT 3650,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_pricing_config_pkey" PRIMARY KEY ("id")
);

-- Seed singleton row so GET always has a database-backed value.
INSERT INTO "platform_pricing_config" ("id", "usdToCopRate", "updatedAt")
VALUES ('singleton', 3650, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
