-- DropForeignKey
ALTER TABLE "barber_appointments" DROP CONSTRAINT "barber_appointments_staffId_fkey";

-- AlterTable
ALTER TABLE "barber_appointments" ALTER COLUMN "staffId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "barber_appointments" ADD CONSTRAINT "barber_appointments_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "barber_staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
