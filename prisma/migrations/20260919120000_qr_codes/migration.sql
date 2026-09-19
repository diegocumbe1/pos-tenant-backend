-- CreateEnum
CREATE TYPE "QrCodeType" AS ENUM ('BUSINESS_CARD', 'PLATFORM');

-- CreateTable
CREATE TABLE "qr_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "QrCodeType" NOT NULL DEFAULT 'BUSINESS_CARD',
    "tenantId" TEXT,
    "targetUrl" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "cardTitle" TEXT,
    "cardSubtitle" TEXT,
    "cardCta" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "qr_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "qr_codes_code_key" ON "qr_codes"("code");
CREATE INDEX "qr_codes_tenantId_idx" ON "qr_codes"("tenantId");

-- Un QR principal por tenant y por tipo.
CREATE UNIQUE INDEX "qr_codes_tenantId_type_key" ON "qr_codes"("tenantId", "type");

-- El índice de arriba NO cubre la fila de plataforma: en Postgres dos NULL no
-- son iguales, así que `(NULL, 'PLATFORM')` podría repetirse y habría dos QR de
-- la landing compitiendo. Este índice parcial es lo que hace que el POST de
-- creación sea idempotente aunque entren dos clics a la vez.
CREATE UNIQUE INDEX "qr_codes_platform_singleton_key"
  ON "qr_codes"("type") WHERE "tenantId" IS NULL;

ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Solo el rol de backend resuelve códigos; la redirección pública pasa por la
-- API, no por PostgREST.
ALTER TABLE "qr_codes" ENABLE ROW LEVEL SECURITY;
