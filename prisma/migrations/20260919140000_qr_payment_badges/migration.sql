-- La escarapela de cobro. A diferencia de la tarjeta de presentación, ESTE QR
-- es de la SEDE: cada sede puede cobrar a una cuenta distinta, y un tenant con
-- tres locales necesita tres escarapelas.

-- AlterEnum. Va primero y sola: Postgres no deja USAR un valor de enum en la
-- misma transacción en que se agrega, y acá no lo usamos, solo lo declaramos.
ALTER TYPE "QrCodeType" ADD VALUE IF NOT EXISTS 'PAYMENT';

-- AlterTable
ALTER TABLE "qr_codes" ADD COLUMN "branchId" TEXT;
ALTER TABLE "qr_codes" ADD COLUMN "scopeId" TEXT;

-- `targetUrl` deja de ser obligatorio: un QR de pagos no redirige a ningún
-- lado, lo atiende Lynko con los datos de cobro de la sede.
ALTER TABLE "qr_codes" ALTER COLUMN "targetUrl" DROP NOT NULL;

-- Backfill del dueño: lo que ya existe es de un tenant, o es el de la landing.
UPDATE "qr_codes" SET "scopeId" = COALESCE("tenantId", 'platform') WHERE "scopeId" IS NULL;
ALTER TABLE "qr_codes" ALTER COLUMN "scopeId" SET NOT NULL;

-- La unicidad pasa a colgar de `scopeId`, que nunca es nulo. Los dos índices
-- que se van dependían de columnas nulas: el compuesto no distinguía dos sedes
-- del mismo tenant, y el parcial no lo sabe representar Prisma, así que el
-- próximo `migrate dev` lo habría borrado sin avisar.
DROP INDEX IF EXISTS "qr_codes_tenantId_type_key";
DROP INDEX IF EXISTS "qr_codes_platform_singleton_key";
CREATE UNIQUE INDEX "qr_codes_scopeId_type_key" ON "qr_codes"("scopeId", "type");

CREATE INDEX "qr_codes_branchId_idx" ON "qr_codes"("branchId");

ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
