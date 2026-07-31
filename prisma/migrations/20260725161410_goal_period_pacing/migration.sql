-- AlterTable
ALTER TABLE "finance_goals" ADD COLUMN     "periodEnd" TIMESTAMP(3),
ADD COLUMN     "periodStart" TIMESTAMP(3),
ADD COLUMN     "periodType" TEXT NOT NULL DEFAULT 'MONTHLY';
