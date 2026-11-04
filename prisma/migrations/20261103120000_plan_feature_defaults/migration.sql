-- Valores de los planes editables desde el backoffice (Ajustes → Planes).
-- Y el interruptor de Pregúntale a Lynko por vertical.
-- Aditiva e idempotente: dos columnas JSONB nullable en el singleton de precios.
ALTER TABLE "platform_pricing_config" ADD COLUMN IF NOT EXISTS "planFeatureDefaults" JSONB;
ALTER TABLE "platform_pricing_config" ADD COLUMN IF NOT EXISTS "assistantVerticals" JSONB;
