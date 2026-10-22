-- Retail: revistas de bodega y aliados que venden.
-- Ver docs/PLAN_RETAIL_AJUSTES_OCTUBRE_2026.md (pos-system) §4–5.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA: dos enums, columnas NULL o con default en bodegas y ajustes,
--     y dos tablas nuevas vacías con sus índices y FKs.
--   · Toda bodega existente queda como EXHIBITION, que es exactamente como
--     funciona hoy: ninguna empieza a liquidar hasta que el dueño la marque
--     como aliada.
--   · Idempotente: bloques DO sobre el catálogo e IF NOT EXISTS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RetailLocationKind') THEN
    CREATE TYPE "RetailLocationKind" AS ENUM ('EXHIBITION', 'ALLY');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RetailStockCountStatus') THEN
    CREATE TYPE "RetailStockCountStatus" AS ENUM ('DRAFT', 'CLOSED', 'CANCELLED');
  END IF;
END $$;

ALTER TABLE "retail_stock_locations" ADD COLUMN IF NOT EXISTS "kind" "RetailLocationKind" NOT NULL DEFAULT 'EXHIBITION';
ALTER TABLE "retail_stock_locations" ADD COLUMN IF NOT EXISTS "countEveryDays" INTEGER;
ALTER TABLE "retail_stock_locations" ADD COLUMN IF NOT EXISTS "allyTiers" JSONB;
ALTER TABLE "retail_stock_locations" ADD COLUMN IF NOT EXISTS "customerId" TEXT;
ALTER TABLE "retail_settings" ADD COLUMN IF NOT EXISTS "allyTiers" JSONB;

CREATE TABLE IF NOT EXISTS "retail_stock_counts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "RetailStockCountStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "expectedUnits" INTEGER NOT NULL DEFAULT 0,
    "countedUnits" INTEGER NOT NULL DEFAULT 0,
    "soldUnits" INTEGER NOT NULL DEFAULT 0,
    "soldValueCOP" INTEGER NOT NULL DEFAULT 0,
    "discountPct" DOUBLE PRECISION,
    "discountCOP" INTEGER NOT NULL DEFAULT 0,
    "netCOP" INTEGER NOT NULL DEFAULT 0,
    "settlementSaleId" TEXT,
    CONSTRAINT "retail_stock_counts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "retail_stock_count_lines" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "name" TEXT NOT NULL,
    "variantLabel" TEXT,
    "categoryName" TEXT,
    "expectedQty" INTEGER NOT NULL,
    "countedQty" INTEGER,
    "unitPriceCOP" INTEGER NOT NULL,
    "unitCostCOP" INTEGER NOT NULL,
    CONSTRAINT "retail_stock_count_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "retail_stock_counts_tenantId_branchId_startedAt_idx" ON "retail_stock_counts"("tenantId", "branchId", "startedAt");
CREATE INDEX IF NOT EXISTS "retail_stock_counts_locationId_status_closedAt_idx" ON "retail_stock_counts"("locationId", "status", "closedAt");
CREATE INDEX IF NOT EXISTS "retail_stock_count_lines_countId_idx" ON "retail_stock_count_lines"("countId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'retail_stock_counts_locationId_fkey') THEN
    ALTER TABLE "retail_stock_counts" ADD CONSTRAINT "retail_stock_counts_locationId_fkey"
      FOREIGN KEY ("locationId") REFERENCES "retail_stock_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'retail_stock_count_lines_countId_fkey') THEN
    ALTER TABLE "retail_stock_count_lines" ADD CONSTRAINT "retail_stock_count_lines_countId_fkey"
      FOREIGN KEY ("countId") REFERENCES "retail_stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
