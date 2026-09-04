-- Devoluciones y cambios del cliente.
--
-- POR QUÉ NO ALCANZA CON ANULAR. `voidSale` deshace la venta ENTERA y la saca
-- del día en que se vendió; sirve para un error de digitación —"esa venta nunca
-- debió existir"—. Una devolución es otra cosa: la venta SÍ ocurrió y hay un
-- hecho nuevo, de OTRO día, que la modifica en parte. El caso real es "vendí el
-- 2 de septiembre y el 5 me devolvieron 2 de las 6". Con anular, la venta del 2
-- desaparecería porque el 5 pasó algo: el histórico mentiría hacia atrás.
-- Anular tampoco sabe de devoluciones parciales ni de cambios.
--
-- LOS TRES CASOS DEL MOSTRADOR SON UNO SOLO:
--   · cambio parejo (mismo aroma por otro)         → diferencia 0
--   · cambio por algo de otro valor                → diferencia + o −
--   · devolución del dinero                        → no se lleva nada
-- Entra mercancía, puede salir otra, y la diferencia se salda. Modelarlos por
-- separado serían tres caminos que hacen lo mismo y que se irían separando.
--
-- QUÉ MUEVE CADA LÍNEA
--   · IN  (vuelve)     suma stock, movimiento RETURN, al costo CONGELADO en la
--                      línea de la venta. No al promedio de hoy: si entre medias
--                      entró mercancía más barata, reingresar al promedio actual
--                      le cambiaría el costo a posteriori a algo que ya salió.
--   · OUT (se lleva)   resta stock, movimiento SALE, al promedio vigente.
--
-- FINANZAS: RESTA EL DÍA DE LA DEVOLUCIÓN, no el de la venta. La venta del 2
-- queda como fue. Es lo coherente con la base caja del resto del módulo: la
-- plata sale el 5. El efecto en el ingreso de ese día es
-- `replacedCOP − returnedCOP`.
--
-- Sin backfill: las devoluciones empiezan a existir desde acá.

-- CreateEnum
CREATE TYPE "RetailSaleReturnKind" AS ENUM ('REFUND', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "RetailReturnSettlement" AS ENUM ('NONE', 'REFUNDED', 'CHARGED', 'PENDING_REFUND', 'PENDING_CHARGE', 'WAIVED');

-- CreateEnum
CREATE TYPE "RetailReturnDirection" AS ENUM ('IN', 'OUT');

-- AlterTable
-- Tope de lo que se puede devolver después: sin este contador se podrían
-- devolver 6 de una venta de 6 tres veces seguidas.
ALTER TABLE "retail_sale_items" ADD COLUMN     "returnedQty" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "retail_sale_returns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "customerId" TEXT,
    "kind" "RetailSaleReturnKind" NOT NULL,
    "returnedCOP" INTEGER NOT NULL DEFAULT 0,
    "replacedCOP" INTEGER NOT NULL DEFAULT 0,
    "balanceCOP" INTEGER NOT NULL DEFAULT 0,
    "settlement" "RetailReturnSettlement" NOT NULL DEFAULT 'NONE',
    "paymentMethod" "RetailPaymentMethod",
    "reason" TEXT,
    "note" TEXT,
    "returnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retail_sale_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retail_sale_return_items" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "direction" "RetailReturnDirection" NOT NULL,
    "saleItemId" TEXT,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "name" TEXT NOT NULL,
    "variantLabel" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPriceCOP" INTEGER NOT NULL,
    "unitCostCOP" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "retail_sale_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "retail_sale_returns_tenantId_code_key" ON "retail_sale_returns"("tenantId", "code");

-- CreateIndex
-- Finanzas pide las devoluciones de un rango de fechas: es la lectura caliente.
CREATE INDEX "retail_sale_returns_tenantId_branchId_returnedAt_idx" ON "retail_sale_returns"("tenantId", "branchId", "returnedAt");

-- CreateIndex
CREATE INDEX "retail_sale_returns_saleId_idx" ON "retail_sale_returns"("saleId");

-- CreateIndex
CREATE INDEX "retail_sale_return_items_returnId_idx" ON "retail_sale_return_items"("returnId");

-- CreateIndex
CREATE INDEX "retail_sale_return_items_saleItemId_idx" ON "retail_sale_return_items"("saleItemId");

-- AddForeignKey
ALTER TABLE "retail_sale_returns" ADD CONSTRAINT "retail_sale_returns_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "retail_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_sale_return_items" ADD CONSTRAINT "retail_sale_return_items_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "retail_sale_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL: si se borra la línea de la venta, el registro de que devolvieron
-- mercancía sigue siendo cierto.
ALTER TABLE "retail_sale_return_items" ADD CONSTRAINT "retail_sale_return_items_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "retail_sale_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_sale_return_items" ADD CONSTRAINT "retail_sale_return_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "retail_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_sale_return_items" ADD CONSTRAINT "retail_sale_return_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "retail_product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
