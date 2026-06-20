/*
  Warnings:

  - Made the column `vertical` on table `notification_preferences` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "barber_settings" ADD COLUMN     "bookingMode" TEXT NOT NULL DEFAULT 'services',
ADD COLUMN     "businessHours" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "notification_events" ALTER COLUMN "vertical" DROP NOT NULL,
ALTER COLUMN "vertical" DROP DEFAULT;

-- AlterTable
ALTER TABLE "notification_preferences" ALTER COLUMN "vertical" SET NOT NULL,
ALTER COLUMN "vertical" SET DEFAULT 'shared';
