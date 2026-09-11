-- Variantes de N dimensiones en retail.
--
-- Hasta ahora una variante era UN valor de UN grupo: "Arrurú". Por eso
-- "¿cuántos Nike blancos talla 38?" no se podía responder — el stock se llevaba
-- por una sola dimensión. A partir de acá una variante es una COMBINACIÓN:
-- ["negro", "38"], y el número de dimensiones no está acotado a dos.
--
-- ESTA MIGRACIÓN NO CAMBIA UN SOLO NÚMERO. Lo que existe hoy es el caso
-- particular de una combinación de un elemento, así que el backfill es una
-- reescritura de forma, no de contenido. Ningún stock se mueve.
--
-- EL HISTÓRICO NO SE TOCA. Kardex, líneas de venta, entregas, devoluciones y
-- saldos por bodega apuntan a `variantId` —la fila—, no a `optionValueId`. La
-- fila sigue siendo la misma: solo cambia cómo se identifica por dentro.
--
-- REVERSIBLE: `optionValueId` y `stockOptionId` se CONSERVAN. Un rollback del
-- despliegue vuelve a leerlos y no pierde nada. Se eliminan en una migración
-- posterior, cuando el código nuevo lleve tiempo en producción.

-- ─── Columnas nuevas ──────────────────────────────────────────────────────────

ALTER TABLE "retail_product_variants"
  ADD COLUMN IF NOT EXISTS "optionValueIds" TEXT[],
  ADD COLUMN IF NOT EXISTS "combinationKey" TEXT;

ALTER TABLE "retail_products"
  ADD COLUMN IF NOT EXISTS "stockOptionIds" TEXT[];

-- ─── Backfill: lo que hay es una combinación de un elemento ───────────────────

UPDATE "retail_product_variants"
   SET "optionValueIds" = ARRAY["optionValueId"],
       "combinationKey" = "optionValueId"
 WHERE "combinationKey" IS NULL
   AND "optionValueId" IS NOT NULL;

UPDATE "retail_products"
   SET "stockOptionIds" = CASE
         WHEN "stockOptionId" IS NULL THEN ARRAY[]::TEXT[]
         ELSE ARRAY["stockOptionId"]
       END
 WHERE "stockOptionIds" IS NULL;

-- ─── Restricciones ────────────────────────────────────────────────────────────

-- Defensa: si quedara alguna fila sin clave, el NOT NULL de abajo fallaría con
-- un error críptico. Mejor que falle acá, diciendo exactamente qué pasó.
DO $$
DECLARE huerfanas INT;
BEGIN
  SELECT COUNT(*) INTO huerfanas
    FROM "retail_product_variants"
   WHERE "combinationKey" IS NULL;
  IF huerfanas > 0 THEN
    RAISE EXCEPTION 'Hay % variante(s) sin optionValueId; revísalas antes de migrar', huerfanas;
  END IF;
END $$;

ALTER TABLE "retail_product_variants"
  ALTER COLUMN "optionValueIds" SET NOT NULL,
  ALTER COLUMN "combinationKey" SET NOT NULL;

ALTER TABLE "retail_products"
  ALTER COLUMN "stockOptionIds" SET NOT NULL,
  ALTER COLUMN "stockOptionIds" SET DEFAULT ARRAY[]::TEXT[];

-- `optionValueId` pasa a nullable: una combinación de varias dimensiones no
-- tiene UN valor único que poner ahí.
ALTER TABLE "retail_product_variants"
  ALTER COLUMN "optionValueId" DROP NOT NULL;

-- ─── Índices ──────────────────────────────────────────────────────────────────

-- El unique viejo era sobre (producto, valor). Con matriz, "Negro" aparece en
-- varias filas (Negro·38, Negro·39) y ese índice las rechazaría.
DROP INDEX IF EXISTS "retail_product_variants_productId_optionValueId_key";

-- Sin este unique, dos filas podrían reclamar la misma combinación y el stock
-- quedaría partido en dos sin que nadie lo note. Es la garantía del modelo.
CREATE UNIQUE INDEX IF NOT EXISTS "retail_product_variants_productId_combinationKey_key"
    ON "retail_product_variants" ("productId", "combinationKey");

-- Para "todo lo que sea talla 38": buscar un valor suelto dentro del array.
CREATE INDEX IF NOT EXISTS "retail_product_variants_optionValueIds_idx"
    ON "retail_product_variants" USING GIN ("optionValueIds");
