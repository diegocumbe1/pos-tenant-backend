-- % de ganancia objetivo con decimales (ej. 62.5)
ALTER TABLE "products" ALTER COLUMN "targetMarginPct" SET DATA TYPE DOUBLE PRECISION;
ALTER TABLE "product_price_history" ALTER COLUMN "targetMarginPct" SET DATA TYPE DOUBLE PRECISION;
