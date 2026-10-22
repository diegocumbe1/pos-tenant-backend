-- Retail: precio de lista con descuento de distribuidor + cumpleaños del cliente.
-- Ver docs/PLAN_RETAIL_AJUSTES_OCTUBRE_2026.md (pos-system) §2 y §3.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA: un enum, columnas NULL o con default, un índice y una FK.
--     No reescribe datos ni cambia el comportamiento de lo que ya existe.
--   · `pricingMode` nace en COST_MARGIN para todos los productos actuales, que
--     es exactamente como se les pone precio hoy.
--   · Las columnas nuevas quedan NULL = "no aplica": proveedor sin % de
--     distribuidor, producto sin proveedor habitual, cliente sin cumpleaños.
--   · Idempotente: IF NOT EXISTS y bloques DO que revisan el catálogo.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RetailPricingMode') THEN
    CREATE TYPE "RetailPricingMode" AS ENUM ('COST_MARGIN', 'LIST_DISCOUNT');
  END IF;
END $$;

-- Producto
ALTER TABLE "retail_products"
  ADD COLUMN IF NOT EXISTS "pricingMode" "RetailPricingMode" NOT NULL DEFAULT 'COST_MARGIN';
ALTER TABLE "retail_products" ADD COLUMN IF NOT EXISTS "supplierId" TEXT;
ALTER TABLE "retail_products" ADD COLUMN IF NOT EXISTS "listDiscountPct" DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS "retail_products_supplierId_idx" ON "retail_products"("supplierId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'retail_products_supplierId_fkey'
  ) THEN
    ALTER TABLE "retail_products"
      ADD CONSTRAINT "retail_products_supplierId_fkey"
      FOREIGN KEY ("supplierId") REFERENCES "retail_suppliers"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Proveedor
ALTER TABLE "retail_suppliers" ADD COLUMN IF NOT EXISTS "listDiscountPct" DOUBLE PRECISION;

-- Cliente
ALTER TABLE "retail_customers" ADD COLUMN IF NOT EXISTS "birthMonth" INTEGER;
ALTER TABLE "retail_customers" ADD COLUMN IF NOT EXISTS "birthDay" INTEGER;
ALTER TABLE "retail_customers" ADD COLUMN IF NOT EXISTS "birthYear" INTEGER;
