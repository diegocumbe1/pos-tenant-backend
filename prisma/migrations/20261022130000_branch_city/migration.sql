-- Ciudad de la sede, agnóstica de vertical.
--
-- Retail no tiene fila en `barber_settings`, que era el único lugar donde se
-- guardaba la ciudad; por eso "Información del negocio" no se podía guardar en
-- una tienda. La dirección ya vivía en `branches`: la ciudad va al lado.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA una columna NULL, sin default: no reescribe filas.
--   · Idempotente: IF NOT EXISTS.

ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "city" TEXT;
