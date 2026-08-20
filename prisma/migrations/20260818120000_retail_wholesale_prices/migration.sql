-- Precios mayoristas opcionales por producto de retail.
--
-- Ambas columnas son NULLABLE y sin default a propósito: NULL significa "este
-- producto no tiene precio por volumen", que es el estado de todo el catálogo
-- existente. Un default 0 diría "se regala a partir de 6 unidades", que es lo
-- contrario de lo que queremos.
--
-- Cambio puramente aditivo: no se toca ninguna columna existente, así que POS,
-- catálogo público, ventas e inventario siguen operando sin desplegar código
-- nuevo. El margen y el descuento frente al PVP NO se guardan: se derivan del
-- costo y del precio de venta vigentes en cada lectura.

-- AlterTable
ALTER TABLE "retail_products" ADD COLUMN     "wholesalePrice6COP" INTEGER,
ADD COLUMN     "wholesalePrice12COP" INTEGER;
