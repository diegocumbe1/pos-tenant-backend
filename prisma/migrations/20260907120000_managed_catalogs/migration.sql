-- Catálogos gestionados: servicio de temporada para vendedores SIN cuenta.
--
-- El dueño del catálogo no entra nunca: lo edita el superadmin desde el
-- backoffice. Por eso estas tablas NO tienen `tenantId` — colgarlas de
-- `public_sites` obligaba a crear un Tenant y un Branch cascarón por catálogo,
-- y eso ensucia el conteo de clientes y los dashboards de MRR.
--
-- Ver docs/CATALOGOS_GESTIONADOS_PLAN.md.

CREATE TYPE "CatalogStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

CREATE TABLE "catalogs" (
  "id"                TEXT NOT NULL,
  "slug"              TEXT NOT NULL,
  "status"            "CatalogStatus" NOT NULL DEFAULT 'DRAFT',

  "businessName"      TEXT NOT NULL,
  "season"            TEXT,
  "city"              TEXT,
  "intro"             TEXT,
  "whatsapp"          TEXT NOT NULL,

  "themePrimary"      TEXT NOT NULL DEFAULT '#d81159',
  "themeAccent"       TEXT NOT NULL DEFAULT '#ffb6c9',
  "themeMode"         TEXT NOT NULL DEFAULT 'light',

  "seoTitle"          TEXT,
  "seoDescription"    TEXT,
  "ogImageUrl"        TEXT,

  "contactName"       TEXT,
  "contactNote"       TEXT,
  "expiresAt"         TIMESTAMP(3),

  "convertedTenantId" TEXT,

  "publishedAt"       TIMESTAMP(3),
  "publishedByUserId" TEXT,

  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "catalogs_pkey" PRIMARY KEY ("id")
);

-- El slug es la URL pública: tiene que ser único en toda la plataforma.
CREATE UNIQUE INDEX "catalogs_slug_key" ON "catalogs"("slug");
CREATE INDEX "catalogs_status_updatedAt_idx" ON "catalogs"("status", "updatedAt");

CREATE TABLE "catalog_products" (
  "id"                 TEXT NOT NULL,
  "catalogId"          TEXT NOT NULL,

  "name"               TEXT NOT NULL,
  "description"        TEXT,
  "category"           TEXT,

  -- Mismos nombres que `retail_products`: la conversión a cliente real es un
  -- copy de filas, no una migración.
  "priceCOP"           INTEGER NOT NULL,
  "wholesalePrice6COP" INTEGER,

  "isAvailable"        BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"          INTEGER NOT NULL DEFAULT 0,

  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "catalog_products_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catalog_products_catalogId_sortOrder_idx"
  ON "catalog_products"("catalogId", "sortOrder");

CREATE TABLE "catalog_product_images" (
  "id"        TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "url"       TEXT NOT NULL,
  -- Ruta en el bucket. Sin ella la imagen no se puede borrar de Supabase.
  "path"      TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "catalog_product_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catalog_product_images_productId_sortOrder_idx"
  ON "catalog_product_images"("productId", "sortOrder");

ALTER TABLE "catalog_products"
  ADD CONSTRAINT "catalog_products_catalogId_fkey"
  FOREIGN KEY ("catalogId") REFERENCES "catalogs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "catalog_product_images"
  ADD CONSTRAINT "catalog_product_images_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "catalog_products"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
