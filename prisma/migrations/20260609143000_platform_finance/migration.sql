-- Finanzas internas del backoffice de plataforma.
-- Aditivo: no toca finanzas tenant-scoped (`expenses`, `finance_goals`).

-- CreateTable
CREATE TABLE "platform_expenses" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "concept" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "incurredAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_finance_goals" (
    "id" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_finance_goals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_expenses_incurredAt_idx" ON "platform_expenses"("incurredAt");

-- CreateIndex
CREATE INDEX "platform_expenses_category_idx" ON "platform_expenses"("category");

-- CreateIndex
CREATE INDEX "platform_finance_goals_periodMonth_idx" ON "platform_finance_goals"("periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "platform_finance_goals_periodMonth_metric_key" ON "platform_finance_goals"("periodMonth", "metric");
