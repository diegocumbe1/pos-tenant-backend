-- Qué se hizo con una sesión pasada del cupo mensual del plan (gimnasio):
--   'NEXT_CYCLE' → la cubre el plan y cuenta en el cupo del mes siguiente.
--   'COURTESY'   → la cubre el plan y no cuenta en ningún cupo.
-- NULL = normal (cuenta en su mes, o se cobra aparte si no la cubre nada).
-- Aditiva e idempotente.
ALTER TABLE "barber_appointments" ADD COLUMN IF NOT EXISTS "quotaMode" TEXT;
