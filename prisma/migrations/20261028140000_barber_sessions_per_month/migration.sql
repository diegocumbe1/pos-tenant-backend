-- Cupo de sesiones por mes de plan (gimnasio): "Personalizado = 8 sesiones al
-- mes". Va en el servicio (la regla) y se copia al cobro (lo que se contrató),
-- igual que `sessionsIncluded` → `sessionsTotal`. null = sin cupo mensual.
-- Aditiva e idempotente; sin backfill: nadie tenía cupo mensual.
ALTER TABLE "barber_services" ADD COLUMN IF NOT EXISTS "sessionsPerMonth" INTEGER;
ALTER TABLE "barber_charges" ADD COLUMN IF NOT EXISTS "sessionsPerMonth" INTEGER;
