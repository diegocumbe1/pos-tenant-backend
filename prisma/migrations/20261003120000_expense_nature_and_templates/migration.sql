-- Gastos con nombre: naturaleza (fijo/variable/ocasional) y gastos recurrentes.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA: no borra, no renombra y no reescribe ningún dato existente.
--   · Columnas nuevas NULL y sin default: en PostgreSQL es un cambio de
--     metadatos, no reescribe la tabla `expenses` ni la bloquea mientras tanto.
--   · Idempotente: cada paso se protege con IF NOT EXISTS, así que correrla de
--     nuevo (o retomarla tras un fallo a medias) no rompe nada.
--   · Los gastos existentes quedan con `nature` NULL = "la de su categoría", que
--     resuelve el backend. No hace falta backfill.
--
-- Las ocurrencias de un recurrente NO se guardan: se calculan al consultar. Solo
-- se guarda el gasto pagado (templateId + templateOccurrence, únicos juntos).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ExpenseNature') THEN
    CREATE TYPE "ExpenseNature" AS ENUM ('FIXED', 'VARIABLE', 'OCCASIONAL');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "expense_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "concept" TEXT NOT NULL,
    "amountCOP" INTEGER NOT NULL,
    "nature" "ExpenseNature",
    "frequency" "ExpenseFrequency" NOT NULL,
    "anchorDay" TEXT NOT NULL,
    "endsOn" TEXT,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "skippedOccurrences" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "expense_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "expense_templates_tenantId_branchId_isActive_deletedAt_idx"
  ON "expense_templates"("tenantId", "branchId", "isActive", "deletedAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_templates_tenantId_fkey') THEN
    ALTER TABLE "expense_templates" ADD CONSTRAINT "expense_templates_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_templates_branchId_fkey') THEN
    ALTER TABLE "expense_templates" ADD CONSTRAINT "expense_templates_branchId_fkey"
      FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "nature" "ExpenseNature";
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "templateId" TEXT;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "templateOccurrence" TEXT;

-- Todos los gastos existentes tienen templateId NULL, y en un índice único los
-- NULL no chocan entre sí: crearlo no puede fallar por datos viejos.
CREATE UNIQUE INDEX IF NOT EXISTS "expenses_templateId_templateOccurrence_key"
  ON "expenses"("templateId", "templateOccurrence");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_templateId_fkey') THEN
    ALTER TABLE "expenses" ADD CONSTRAINT "expenses_templateId_fkey"
      FOREIGN KEY ("templateId") REFERENCES "expense_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
