-- Dirección y ciudad del cliente de retail, para la cuenta de cobro a empresas.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA dos columnas NULL sin default a `retail_customers`: cambio de
--     metadatos, no reescribe la tabla ni la bloquea, no toca datos existentes.
--   · Los clientes ya registrados quedan con NULL = "sin dirección", que es
--     como estaban.
--   · Idempotente: IF NOT EXISTS.

ALTER TABLE "retail_customers" ADD COLUMN IF NOT EXISTS "address" TEXT;
ALTER TABLE "retail_customers" ADD COLUMN IF NOT EXISTS "city" TEXT;
