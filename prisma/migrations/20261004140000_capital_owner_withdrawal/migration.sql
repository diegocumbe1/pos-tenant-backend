-- "Saqué plata del negocio" y en qué se usó.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Agrega un valor al enum y una columna NULL sin default: no reescribe ni
--     bloquea la tabla, no toca datos existentes.
--   · Idempotente: ADD VALUE IF NOT EXISTS y ADD COLUMN IF NOT EXISTS.

ALTER TYPE "CapitalMovementKind" ADD VALUE IF NOT EXISTS 'OWNER_WITHDRAWAL';

ALTER TABLE "capital_movements" ADD COLUMN IF NOT EXISTS "purpose" TEXT;
