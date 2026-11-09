-- Reservas por bloques sin precio guardado: les pone el precio de SU duración.
--
-- El bug: una reserva de 2 h en una cancha de $30.000/h no guardaba precio y
-- todo (detalle, cobro, Finanzas, comisiones) caía al precio del servicio, que es
-- el de 1 h. Desde el 9 nov 2026 el código guarda el precio al crear y al mover;
-- esto corrige las que ya existían.
--
-- Regla (igual a priceForMinutes en código): si el servicio tiene un bloque con
-- precio propio para esos minutos, ese; si no, proporcional a la tarifa por hora.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo toca citas con "priceCOP" NULL (no tienen precio registrado).
--   · Nunca cambia un precio ya guardado (completadas, reservas fijas, cobros).
--   · Excluye asistencias a clases y la duración base del servicio.
--   · Idempotente: tras correr, esas citas ya no tienen "priceCOP" NULL.

WITH target AS (
  SELECT
    a."id",
    ROUND(EXTRACT(EPOCH FROM (a."scheduledEnd" - a."scheduledAt")) / 60)::int AS minutes,
    s."priceCOP" AS base_price,
    s."durationMin" AS base_minutes,
    s."durationOptions" AS options
  FROM "barber_appointments" a
  JOIN "barber_services" s ON s."id" = a."serviceId"
  WHERE a."priceCOP" IS NULL
    AND a."classSessionId" IS NULL
    AND s."durationMin" > 0
    AND ROUND(EXTRACT(EPOCH FROM (a."scheduledEnd" - a."scheduledAt")) / 60) <> s."durationMin"
),
priced AS (
  SELECT
    t."id",
    COALESCE(
      (
        SELECT (o->>'price')::int
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(t.options::jsonb) = 'array' THEN t.options::jsonb ELSE '[]'::jsonb END
        ) o
        WHERE (o->>'minutes') ~ '^[0-9]+$'
          AND (o->>'minutes')::int = t.minutes
          AND (o->>'price') ~ '^[0-9]+$'
        LIMIT 1
      ),
      ROUND((t.minutes / 60.0) * ROUND(t.base_price / (t.base_minutes / 60.0)))::int
    ) AS price
  FROM target t
)
UPDATE "barber_appointments" a
SET "priceCOP" = p.price
FROM priced p
WHERE a."id" = p."id";
