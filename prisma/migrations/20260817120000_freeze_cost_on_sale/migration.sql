-- Paso 1 del plan docs/PLAN_UTILIDAD_REAL_Y_STOCK.md — congelar el costo en la venta.
--
-- Todas las columnas son NULLABLE a propósito (salvo barber_services.costCOP, que
-- lleva default 0 por ser una captura manual): el histórico anterior queda en NULL
-- y NULL significa "no sabemos cuánto costó", nunca "costó cero". Poner 0 por
-- defecto inflaría el margen de todas las ventas viejas.
--
-- Cambio aditivo: ninguna columna existente se toca, así que la operación actual
-- (POS, comanda, arqueo) sigue funcionando igual sin desplegar código nuevo.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "costCOP" INTEGER;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "unitCostCOP" INTEGER;

-- AlterTable
ALTER TABLE "payment_split_items" ADD COLUMN     "unitCostCOP" INTEGER;

-- AlterTable
ALTER TABLE "barber_services" ADD COLUMN     "costCOP" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "barber_appointments" ADD COLUMN     "priceCOP" INTEGER,
ADD COLUMN     "costCOP" INTEGER;
