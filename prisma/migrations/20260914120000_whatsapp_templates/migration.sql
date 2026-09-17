-- Plantillas de WhatsApp editables por el negocio.
-- Solo se guarda lo personalizado: sin fila, el envío usa el default del código.

CREATE TYPE "WhatsappTemplateKey" AS ENUM (
  'APPOINTMENT_BUSINESS',
  'APPOINTMENT_CUSTOMER',
  'ORDER_BUSINESS',
  'ORDER_CUSTOMER'
);

CREATE TABLE "whatsapp_templates" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "key"       "WhatsappTemplateKey" NOT NULL,
  "body"      TEXT NOT NULL,
  "enabled"   BOOLEAN NOT NULL DEFAULT true,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "whatsapp_templates_tenantId_idx" ON "whatsapp_templates"("tenantId");

CREATE UNIQUE INDEX "whatsapp_templates_tenantId_key_key" ON "whatsapp_templates"("tenantId", "key");

ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
