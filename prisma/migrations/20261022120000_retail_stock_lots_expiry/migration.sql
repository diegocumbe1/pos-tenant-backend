-- Retail: fechas de vencimiento por lote, ajustes de tienda y permiso de alertas.
-- Ver docs/PLAN_RETAIL_AJUSTES_OCTUBRE_2026.md (pos-system) §1.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA: dos columnas en `retail_products` (una con default false,
--     otra NULL), dos tablas nuevas vacías, sus índices y FKs, y un permiso.
--   · `tracksExpiry` nace en false para todos los productos: ninguno empieza a
--     pedir fechas ni a consumir lotes hasta que el dueño lo encienda.
--   · `retail_settings` nace vacía: sin fila, la tienda usa los defaults.
--   · Idempotente: IF NOT EXISTS, bloques DO sobre el catálogo y ON CONFLICT.

ALTER TABLE "retail_products" ADD COLUMN IF NOT EXISTS "tracksExpiry" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "retail_products" ADD COLUMN IF NOT EXISTS "expiryAlertDays" INTEGER;

CREATE TABLE IF NOT EXISTS "retail_stock_lots" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "locationId" TEXT NOT NULL,
    "expiresOn" DATE NOT NULL,
    "lotCode" TEXT,
    "qty" INTEGER NOT NULL,
    "receivedQty" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "retail_stock_lots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "retail_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "expiryAlertDays" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "retail_settings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "retail_stock_lots_tenantId_branchId_expiresOn_idx" ON "retail_stock_lots"("tenantId", "branchId", "expiresOn");
CREATE INDEX IF NOT EXISTS "retail_stock_lots_locationId_productId_variantId_idx" ON "retail_stock_lots"("locationId", "productId", "variantId");
CREATE INDEX IF NOT EXISTS "retail_stock_lots_productId_idx" ON "retail_stock_lots"("productId");
CREATE UNIQUE INDEX IF NOT EXISTS "retail_settings_tenantId_branchId_key" ON "retail_settings"("tenantId", "branchId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'retail_stock_lots_productId_fkey') THEN
    ALTER TABLE "retail_stock_lots" ADD CONSTRAINT "retail_stock_lots_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "retail_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'retail_stock_lots_variantId_fkey') THEN
    ALTER TABLE "retail_stock_lots" ADD CONSTRAINT "retail_stock_lots_variantId_fkey"
      FOREIGN KEY ("variantId") REFERENCES "retail_product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'retail_stock_lots_locationId_fkey') THEN
    ALTER TABLE "retail_stock_lots" ADD CONSTRAINT "retail_stock_lots_locationId_fkey"
      FOREIGN KEY ("locationId") REFERENCES "retail_stock_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Permiso nuevo: ver las alertas de vencimiento. Por defecto solo el dueño
-- (OWNER), como pidió Diego ("solo el admin"); a los demás roles se les da
-- desde Ajustes → Roles y permisos.
INSERT INTO "permissions" ("id", "code", "resource", "action", "description")
VALUES (
  gen_random_uuid()::text,
  'retail:inventory:expiry',
  'retail-inventory',
  'expiry',
  'Ver y gestionar vencimientos de la tienda'
)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE p."code" = 'retail:inventory:expiry'
  AND r."code" = 'OWNER'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
