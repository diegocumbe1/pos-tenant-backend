-- Reglas de lealtad por sede, guardadas en el servidor (antes vivían solo en el
-- navegador de quien las creó).
--
-- SEGURA PARA PRODUCCIÓN:
--   · Añade UNA columna con DEFAULT constante ('[]'): en PostgreSQL 11+ no
--     reescribe la tabla.
--   · IF NOT EXISTS: repetirla no cambia nada.
--   · No toca `loyaltyEnabled` ni ninguna otra columna ni dato existente.

ALTER TABLE "barber_settings" ADD COLUMN IF NOT EXISTS "loyaltyRules" JSONB NOT NULL DEFAULT '[]';
