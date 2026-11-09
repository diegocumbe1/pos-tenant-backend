-- Agendar sin cliente registrado (solo dueño/gerente, con nota obligatoria).
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo relaja una restricción: barber_appointments."customerId" admite NULL.
--   · No toca datos: todas las citas existentes siguen con su cliente.
--   · La llave foránea se conserva tal cual.
--   · Idempotente: DROP NOT NULL sobre una columna que ya admite NULL no falla.

ALTER TABLE "barber_appointments" ALTER COLUMN "customerId" DROP NOT NULL;
