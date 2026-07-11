-- Frecuencia de pago + bonos/deducciones en nómina
CREATE TYPE "PayFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY');

ALTER TABLE "payrolls"
  ADD COLUMN "payFrequency" "PayFrequency" NOT NULL DEFAULT 'MONTHLY',
  ADD COLUMN "bonusesCOP" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deductionsCOP" INTEGER NOT NULL DEFAULT 0;

-- Backfill: deducciones = bruto - neto para filas existentes
UPDATE "payrolls" SET "deductionsCOP" = GREATEST("grossCOP" - "netCOP", 0);
