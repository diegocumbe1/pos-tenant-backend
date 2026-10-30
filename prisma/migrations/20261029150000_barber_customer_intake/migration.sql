-- Ficha de inscripción del sitio público (gimnasio): datos, salud, deporte,
-- objetivo, disponibilidad y consentimientos. Aditiva e idempotente.
ALTER TABLE "barber_customers" ADD COLUMN IF NOT EXISTS "intake" JSONB;
