-- Bodegas / ubicaciones de stock en retail.
--
-- Esta migración NO CAMBIA UN SOLO NÚMERO: solo le pone nombre al lugar donde ya
-- estaba todo. Cada tienda estrena una "Bodega principal" con la totalidad de su
-- inventario, que es exactamente donde figuraba hasta ahora.
--
-- IDS DERIVADOS: la principal de cada tienda es 'loc_<tenantId>_<branchId>' y
-- cada saldo 'bal_<locationId>_<productId|variantId>'. Volver a correr esto no
-- duplica nada; los ON CONFLICT son el seguro.

-- ─── Tablas ───────────────────────────────────────────────────────────────────

CREATE TABLE "retail_stock_locations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "holderName" TEXT,
    "phone" TEXT,
    "note" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retail_stock_locations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "retail_stock_locations_tenantId_branchId_isActive_idx"
    ON "retail_stock_locations"("tenantId", "branchId", "isActive");

-- Exactamente una principal por tienda. Es la que recibe todo lo que nadie
-- repartió, así que dos serían dos verdades sobre el mismo stock.
CREATE UNIQUE INDEX "retail_stock_locations_one_default"
    ON "retail_stock_locations"("tenantId", "branchId")
    WHERE "isDefault";

CREATE TABLE "retail_stock_balances" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "minQty" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retail_stock_balances_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "retail_stock_balances_tenantId_branchId_productId_idx"
    ON "retail_stock_balances"("tenantId", "branchId", "productId");
CREATE INDEX "retail_stock_balances_locationId_productId_idx"
    ON "retail_stock_balances"("locationId", "productId");

-- DOS ÍNDICES PARCIALES Y NO UN UNIQUE NORMAL: en Postgres dos NULL nunca son
-- iguales, así que un UNIQUE sobre ("locationId","productId","variantId")
-- dejaría entrar infinitas filas del producto entero en la misma bodega — que
-- es justo la fila que se duplicaría.
CREATE UNIQUE INDEX "retail_stock_balances_product_unique"
    ON "retail_stock_balances"("locationId", "productId")
    WHERE "variantId" IS NULL;
CREATE UNIQUE INDEX "retail_stock_balances_variant_unique"
    ON "retail_stock_balances"("locationId", "productId", "variantId")
    WHERE "variantId" IS NOT NULL;

CREATE TABLE "retail_product_price_history" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "priceCOP" INTEGER NOT NULL,
    "prevPriceCOP" INTEGER,
    "costCOP" INTEGER NOT NULL,
    "prevCostCOP" INTEGER,
    "reason" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retail_product_price_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "retail_product_price_history_tenantId_productId_createdAt_idx"
    ON "retail_product_price_history"("tenantId", "productId", "createdAt");

-- ─── Columnas nuevas en lo que ya existía ────────────────────────────────────

ALTER TABLE "retail_stock_movements"
    ADD COLUMN "locationId" TEXT,
    ADD COLUMN "toLocationId" TEXT;

CREATE INDEX "retail_stock_movements_locationId_createdAt_idx"
    ON "retail_stock_movements"("locationId", "createdAt");

ALTER TABLE "retail_sale_items" ADD COLUMN "locationId" TEXT;

-- ─── Llaves foráneas ─────────────────────────────────────────────────────────

ALTER TABLE "retail_stock_locations"
    ADD CONSTRAINT "retail_stock_locations_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "retail_stock_locations"
    ADD CONSTRAINT "retail_stock_locations_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "retail_stock_balances"
    ADD CONSTRAINT "retail_stock_balances_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "retail_stock_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "retail_stock_balances"
    ADD CONSTRAINT "retail_stock_balances_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "retail_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "retail_stock_balances"
    ADD CONSTRAINT "retail_stock_balances_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "retail_product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "retail_product_price_history"
    ADD CONSTRAINT "retail_product_price_history_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "retail_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "retail_stock_movements"
    ADD CONSTRAINT "retail_stock_movements_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "retail_stock_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "retail_stock_movements"
    ADD CONSTRAINT "retail_stock_movements_toLocationId_fkey"
    FOREIGN KEY ("toLocationId") REFERENCES "retail_stock_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "retail_sale_items"
    ADD CONSTRAINT "retail_sale_items_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "retail_stock_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Backfill ────────────────────────────────────────────────────────────────

-- 1. Una "Bodega principal" por cada tienda que tenga productos de retail.
INSERT INTO "retail_stock_locations" (
    "id", "tenantId", "branchId", "name", "isDefault", "isActive", "sortOrder", "updatedAt"
)
SELECT DISTINCT
    'loc_' || p."tenantId" || '_' || p."branchId",
    p."tenantId",
    p."branchId",
    'Bodega principal',
    true,
    true,
    0,
    CURRENT_TIMESTAMP
FROM "retail_products" p
ON CONFLICT ("id") DO NOTHING;

-- 2. Los saldos arrancan con lo que hay hoy, todo en la principal.
--
-- DOS PASADAS Y NO UNA. Un producto que reparte por aroma tiene su total en
-- `stock` y el reparto en las variantes, y lo que no se ha repartido
-- (`stock - Σ variants.stock`) no pertenece a ningún aroma. Meterlo todo en una
-- sola fila perdería el reparto; meterlo solo en las variantes perdería lo no
-- repartido. Así que van las dos: la fila del producto entero lleva el
-- remanente, y cada variante lleva el suyo. La suma sigue dando `stock`.

-- 2a. Producto entero: todo su stock si no reparte, y el remanente si reparte.
INSERT INTO "retail_stock_balances" (
    "id", "tenantId", "branchId", "locationId", "productId", "variantId",
    "qty", "minQty", "updatedAt"
)
SELECT
    'bal_' || p."id",
    p."tenantId",
    p."branchId",
    'loc_' || p."tenantId" || '_' || p."branchId",
    p."id",
    NULL,
    p."stock" - COALESCE((
        SELECT SUM(v."stock") FROM "retail_product_variants" v WHERE v."productId" = p."id"
    ), 0),
    p."minStock",
    CURRENT_TIMESTAMP
FROM "retail_products" p
WHERE p."trackStock"
ON CONFLICT ("id") DO NOTHING;

-- 2b. Una fila por aroma con lo que ya tenía repartido.
INSERT INTO "retail_stock_balances" (
    "id", "tenantId", "branchId", "locationId", "productId", "variantId",
    "qty", "minQty", "updatedAt"
)
SELECT
    'bal_' || v."id",
    v."tenantId",
    v."branchId",
    'loc_' || v."tenantId" || '_' || v."branchId",
    v."productId",
    v."id",
    v."stock",
    v."minStock",
    CURRENT_TIMESTAMP
FROM "retail_product_variants" v
ON CONFLICT ("id") DO NOTHING;

-- 3. Todo el kardex existente queda estampado en la principal, para que los
--    saldos por bodega cuadren hacia atrás en vez de arrancar cojos.
UPDATE "retail_stock_movements" m
SET "locationId" = 'loc_' || m."tenantId" || '_' || m."branchId"
WHERE m."locationId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "retail_stock_locations" l
    WHERE l."id" = 'loc_' || m."tenantId" || '_' || m."branchId"
  );

-- 4. Y las ventas anteriores, que es donde efectivamente estaba la mercancía.
UPDATE "retail_sale_items" i
SET "locationId" = 'loc_' || s."tenantId" || '_' || s."branchId"
FROM "retail_sales" s
WHERE i."saleId" = s."id"
  AND i."locationId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "retail_stock_locations" l
    WHERE l."id" = 'loc_' || s."tenantId" || '_' || s."branchId"
  );

-- 5. El precio de hoy como primer punto del histórico. Sin esto, abrir un
--    producto viejo mostraría un histórico vacío, que se lee como "este precio
--    nunca se puso" en vez de "esto es anterior al histórico".
INSERT INTO "retail_product_price_history" (
    "id", "tenantId", "branchId", "productId",
    "priceCOP", "prevPriceCOP", "costCOP", "prevCostCOP", "reason", "createdAt"
)
SELECT
    'prcbf_' || p."id",
    p."tenantId",
    p."branchId",
    p."id",
    p."priceCOP",
    NULL,
    p."costCOP",
    NULL,
    'Precio vigente al empezar a llevar histórico',
    p."createdAt"
FROM "retail_products" p
ON CONFLICT ("id") DO NOTHING;
