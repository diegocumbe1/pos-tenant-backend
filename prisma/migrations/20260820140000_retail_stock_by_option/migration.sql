-- Existencias repartidas por valor de opción (aroma, sabor, presentación).
--
-- Hasta ahora las opciones de producto eran solo presentación y el stock era
-- del producto entero: se sabía que quedaban 11 mantequillas, pero no cuántas
-- de Arrurú y cuántas de Sandía, así que no había forma de decidir qué reponer.
--
-- MODELO. `RetailProduct.stockOptionId` señala QUÉ grupo reparte (NULL = no
-- reparte, comportamiento de siempre). Hay una fila de variante por valor de
-- ese grupo, no una por combinación de todos los grupos: 6 aromas × 3 colores
-- son 6 filas, no 18. El color sigue siendo presentación.
--
-- `retail_products.stock` NO cambia de significado: sigue siendo el total
-- físico y la fuente de verdad del número que se muestra. Las variantes dicen
-- CUÁLES son esas unidades. Lo que todavía no se contó por aroma es la resta
-- (`stock - Σ variants.stock`) y se muestra como pendiente de repartir, en vez
-- de inventar un reparto que no corresponde a lo que hay en la estantería.
--
-- Todo es aditivo y nullable: el catálogo existente queda con stockOptionId
-- NULL y cero variantes, o sea exactamente como está hoy. Ninguna venta ni
-- movimiento de kardex anterior cambia de sentido.

-- CreateTable
CREATE TABLE "retail_product_variants" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "optionValueId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sku" TEXT,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "minStock" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retail_product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "retail_product_variants_productId_optionValueId_key" ON "retail_product_variants"("productId", "optionValueId");

-- CreateIndex
CREATE INDEX "retail_product_variants_tenantId_branchId_idx" ON "retail_product_variants"("tenantId", "branchId");

-- AlterTable
ALTER TABLE "retail_products" ADD COLUMN     "stockOptionId" TEXT;

-- AlterTable
-- NULL en el kardex = movimiento del producto entero. Es lo correcto para todo
-- lo que ya está grabado: esos movimientos no sabían de aromas.
ALTER TABLE "retail_stock_movements" ADD COLUMN     "variantId" TEXT;

-- AlterTable
ALTER TABLE "retail_sale_items" ADD COLUMN     "variantId" TEXT,
ADD COLUMN     "variantLabel" TEXT;

-- AddForeignKey
ALTER TABLE "retail_product_variants" ADD CONSTRAINT "retail_product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "retail_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL y no CASCADE: si se borra el aroma, el movimiento de kardex debe
-- sobrevivir. Se pierde el enlace, no el registro de que salió mercancía.
ALTER TABLE "retail_stock_movements" ADD CONSTRAINT "retail_stock_movements_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "retail_product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- Igual que arriba: la venta ya cobrada no se toca. La etiqueta queda copiada
-- en `variantLabel`, así que el recibo sigue diciendo "Arrurú" para siempre.
ALTER TABLE "retail_sale_items" ADD CONSTRAINT "retail_sale_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "retail_product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
