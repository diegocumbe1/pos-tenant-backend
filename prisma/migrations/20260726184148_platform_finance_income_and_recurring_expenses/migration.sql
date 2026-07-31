-- AlterTable
ALTER TABLE "platform_expenses" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'one_time',
ADD COLUMN     "periodEnd" TIMESTAMP(3),
ADD COLUMN     "periodStart" TIMESTAMP(3),
ADD COLUMN     "recurringExpenseId" TEXT,
ADD COLUMN     "vendor" TEXT;

-- AlterTable
ALTER TABLE "subscription_payments" ADD COLUMN     "countsAsRevenue" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "discountApplied" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discountReason" TEXT,
ADD COLUMN     "extendsPeriod" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'payment',
ADD COLUMN     "officialPrice" INTEGER,
ADD COLUMN     "receiptUrl" TEXT,
ADD COLUMN     "subscriptionId" TEXT;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "agreedPriceCOP" INTEGER,
ADD COLUMN     "agreedPriceUSD" INTEGER,
ADD COLUMN     "discountApprovedBy" TEXT,
ADD COLUMN     "discountReason" TEXT,
ADD COLUMN     "graceEndsAt" TIMESTAMP(3),
ADD COLUMN     "listPriceCOP" INTEGER,
ADD COLUMN     "listPriceUSD" INTEGER,
ADD COLUMN     "nextPaymentDueAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "platform_recurring_expenses" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "concept" TEXT NOT NULL,
    "vendor" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "recurrence" TEXT NOT NULL DEFAULT 'monthly',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "nextChargeAt" TIMESTAMP(3) NOT NULL,
    "lastChargeAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "autoGenerate" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_recurring_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_recurring_expenses_isActive_nextChargeAt_idx" ON "platform_recurring_expenses"("isActive", "nextChargeAt");

-- CreateIndex
CREATE INDEX "platform_recurring_expenses_category_idx" ON "platform_recurring_expenses"("category");

-- CreateIndex
CREATE INDEX "platform_expenses_recurringExpenseId_idx" ON "platform_expenses"("recurringExpenseId");

-- CreateIndex
CREATE INDEX "subscription_payments_subscriptionId_idx" ON "subscription_payments"("subscriptionId");

-- CreateIndex
CREATE INDEX "subscription_payments_countsAsRevenue_paidAt_idx" ON "subscription_payments"("countsAsRevenue", "paidAt");

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_expenses" ADD CONSTRAINT "platform_expenses_recurringExpenseId_fkey" FOREIGN KEY ("recurringExpenseId") REFERENCES "platform_recurring_expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
