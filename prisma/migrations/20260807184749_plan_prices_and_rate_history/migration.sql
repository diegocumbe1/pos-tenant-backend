-- CreateTable
CREATE TABLE "plan_prices" (
    "id" TEXT NOT NULL,
    "verticalCode" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "priceUSD" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_rates" (
    "id" TEXT NOT NULL,
    "usdToCopRate" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_prices_verticalCode_planCode_effectiveFrom_idx" ON "plan_prices"("verticalCode", "planCode", "effectiveFrom");

-- CreateIndex
CREATE INDEX "platform_rates_effectiveFrom_idx" ON "platform_rates"("effectiveFrom");
