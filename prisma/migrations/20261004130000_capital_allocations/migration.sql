-- A qué gasto corresponde cada aporte del dueño (todo o una parte).
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo CREA una tabla nueva. No altera tablas existentes ni toca datos.
--   · Idempotente: IF NOT EXISTS y constraints protegidos con bloques DO.
--   · Si se borra un gasto o un aporte, su vínculo se borra con él (CASCADE):
--     nunca queda un vínculo apuntando a nada.

CREATE TABLE IF NOT EXISTS "capital_allocations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "capitalMovementId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "amountCOP" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capital_allocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "capital_allocations_capitalMovementId_expenseId_key"
  ON "capital_allocations"("capitalMovementId", "expenseId");
CREATE INDEX IF NOT EXISTS "capital_allocations_expenseId_idx"
  ON "capital_allocations"("expenseId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'capital_allocations_capitalMovementId_fkey') THEN
    ALTER TABLE "capital_allocations" ADD CONSTRAINT "capital_allocations_capitalMovementId_fkey"
      FOREIGN KEY ("capitalMovementId") REFERENCES "capital_movements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'capital_allocations_expenseId_fkey') THEN
    ALTER TABLE "capital_allocations" ADD CONSTRAINT "capital_allocations_expenseId_fkey"
      FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
