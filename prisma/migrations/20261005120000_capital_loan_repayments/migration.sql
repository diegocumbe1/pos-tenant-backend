-- Abonos ligados a su préstamo: qué préstamo salda cada abono y de dónde salió.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA dos columnas NULL sin default a `capital_movements`: cambio de
--     metadatos, no reescribe la tabla ni la bloquea, no toca datos existentes.
--   · Los abonos ya registrados quedan con NULL = "sin préstamo asignado" y
--     "pagado con la caja del negocio", que es exactamente como contaban antes.
--   · Si se borra un préstamo, sus abonos NO se borran: el vínculo queda en NULL
--     (ON DELETE SET NULL). Nunca se pierde un abono.
--   · Idempotente: IF NOT EXISTS y constraint protegido con un bloque DO.

ALTER TABLE "capital_movements" ADD COLUMN IF NOT EXISTS "repaysMovementId" TEXT;
ALTER TABLE "capital_movements" ADD COLUMN IF NOT EXISTS "paidFromBusiness" BOOLEAN;

CREATE INDEX IF NOT EXISTS "capital_movements_repaysMovementId_idx"
  ON "capital_movements"("repaysMovementId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'capital_movements_repaysMovementId_fkey') THEN
    ALTER TABLE "capital_movements" ADD CONSTRAINT "capital_movements_repaysMovementId_fkey"
      FOREIGN KEY ("repaysMovementId") REFERENCES "capital_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
