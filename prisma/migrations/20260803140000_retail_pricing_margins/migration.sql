-- Precio por porcentaje en retail: se guarda el % con el que se sugirió el
-- precio y el piso de negociación (precio mínimo) que solo ve el admin.
ALTER TABLE "retail_products" ADD COLUMN "saleMarginPct" DOUBLE PRECISION;
ALTER TABLE "retail_products" ADD COLUMN "minPriceCOP" INTEGER;
ALTER TABLE "retail_products" ADD COLUMN "minMarginPct" DOUBLE PRECISION;
