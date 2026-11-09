-- Descuento por combo de verticales (2 o 3): la más cara a precio completo y cada
-- vertical adicional con `additionalBps` de descuento. Append-only con fecha efectiva.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Crea una tabla nueva; no toca ninguna existente.
--   · Inserta UNA fila inicial (30%) solo si la tabla está vacía. Hoy solo la leen
--     la landing y el backoffice para mostrar el precio del combo: ningún cobro la usa
--     todavía (eso llega con el cobro unificado).
--   · Idempotente: IF NOT EXISTS y el INSERT protegido con NOT EXISTS.

CREATE TABLE IF NOT EXISTS "plan_bundle_discounts" (
  "id" TEXT NOT NULL,
  "additionalBps" INTEGER NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "note" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plan_bundle_discounts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "plan_bundle_discounts_effectiveFrom_idx"
  ON "plan_bundle_discounts"("effectiveFrom");

INSERT INTO "plan_bundle_discounts" ("id", "additionalBps", "effectiveFrom", "note", "createdBy")
SELECT 'bundle-initial-2026-11-07', 3000, TIMESTAMP '2026-11-07 00:00:00', 'Valor inicial validado: 30% por cada vertical adicional', 'migration'
WHERE NOT EXISTS (SELECT 1 FROM "plan_bundle_discounts");
