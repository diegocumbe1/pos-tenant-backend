-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "paymentInfo" JSONB;

-- AlterTable
ALTER TABLE "printers" ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "port" INTEGER DEFAULT 9100;
