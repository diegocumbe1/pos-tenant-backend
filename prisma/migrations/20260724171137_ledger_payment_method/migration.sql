-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'TRANSFER');

-- AlterTable
ALTER TABLE "staff_ledger_entries" ADD COLUMN     "accountLabel" TEXT,
ADD COLUMN     "coversFrom" TIMESTAMP(3),
ADD COLUMN     "coversTo" TIMESTAMP(3),
ADD COLUMN     "method" "PaymentMethod";
