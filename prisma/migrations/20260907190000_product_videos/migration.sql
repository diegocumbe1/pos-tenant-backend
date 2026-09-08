-- Videos de producto, en catálogos gestionados y en retail.
--
-- POR QUÉ. Un clip de 15 segundos mostrando la flor eterna encendida vende más
-- que tres fotos, y hoy el vendedor no tenía dónde ponerlo: lo mandaba suelto
-- por WhatsApp, que es justo lo que el catálogo vino a reemplazar.
--
-- NO SE TRANSCODIFICA (ver `ImageUploadService.uploadVideo`): el freno es el
-- tamaño de entrada, 20 MB. Quien los muestre debe usar `preload="none"` y un
-- `poster`, o el visitante paga megas por un video que quizá nunca toque.

-- ─── Catálogos: la tabla de imágenes pasa a ser de medios ───────────────────
--
-- Se RENOMBRA en vez de crear una tabla nueva: `catalog_product_images` con un
-- video adentro sería un nombre que miente, y esta tabla nació ayer con datos de
-- prueba. Renombrar ahora cuesta una migración; dejarlo cuesta que cada persona
-- que lea el esquema tenga que preguntar.

CREATE TYPE "CatalogMediaKind" AS ENUM ('IMAGE', 'VIDEO');

ALTER TABLE "catalog_product_images" RENAME TO "catalog_product_media";

ALTER TABLE "catalog_product_media"
  RENAME CONSTRAINT "catalog_product_images_pkey" TO "catalog_product_media_pkey";
ALTER TABLE "catalog_product_media"
  RENAME CONSTRAINT "catalog_product_images_productId_fkey" TO "catalog_product_media_productId_fkey";
ALTER INDEX "catalog_product_images_productId_sortOrder_idx"
  RENAME TO "catalog_product_media_productId_sortOrder_idx";

-- Todo lo que existía era imagen WebP: ese es el default correcto para el
-- backfill y para las filas que vengan sin especificar.
ALTER TABLE "catalog_product_media"
  ADD COLUMN "kind"        "CatalogMediaKind" NOT NULL DEFAULT 'IMAGE',
  ADD COLUMN "contentType" TEXT NOT NULL DEFAULT 'image/webp',
  ADD COLUMN "sizeBytes"   INTEGER;

-- ─── Retail: videos aparte de las fotos ─────────────────────────────────────
--
-- Columna propia y no mezclados en `imageUrls`: se muestran distinto —hay que
-- tocarlos para que carguen— y pesan dos órdenes de magnitud más. Mezclarlos
-- obligaría a adivinar por la extensión en cada pantalla que los pinte.
ALTER TABLE "retail_products"
  ADD COLUMN "videoUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
