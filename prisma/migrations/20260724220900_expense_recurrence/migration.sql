-- CreateEnum
CREATE TYPE "ExpenseFrequency" AS ENUM ('ONE_TIME', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'ANNUAL');

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "dueDate" TIMESTAMP(3),
ADD COLUMN     "frequency" "ExpenseFrequency" NOT NULL DEFAULT 'ONE_TIME',
ADD COLUMN     "isRecurring" BOOLEAN NOT NULL DEFAULT false;
