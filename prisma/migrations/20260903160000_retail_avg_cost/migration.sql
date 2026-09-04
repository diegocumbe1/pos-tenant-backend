-- Costo promedio ponderado: saber la ganancia real.
--
-- EL PROBLEMA. `retail_products.costCOP` hacía TRES trabajos con un solo número:
--   · base del precio y del margen   → necesita el costo de REPOSICIÓN
--   · costo de la venta (utilidad)   → necesita lo que costó LO QUE SALIÓ
--   · valor del inventario           → necesita el costo de LO QUE HAY
-- Mientras todo se compra al mismo precio los tres coinciden y nadie lo nota. Se
-- separan en cuanto entra mercancía a otro costo. El caso que lo destapó fue un
-- sobrante que el proveedor mandó por error y entró a $0: reponer una unidad
-- sigue costando 16.000, pero lo que hay en bodega ya no costó 16.000 cada una.
-- Vendiéndolas, el sistema seguía descontando 16.000 de costo y la utilidad
-- salía SUBESTIMADA.
--
-- CÓMO QUEDA. `costCOP` conserva un solo significado —costo de reposición, el
-- que manda al poner precios— y el nuevo `avgCostCOP` lleva el promedio de lo
-- que hay. Solo lo mueven las ENTRADAS:
--
--   nuevo = (stockAntes × promedioAntes + entrada × costoEntrada)
--           ─────────────────────────────────────────────────────
--                        stockAntes + entrada
--
-- Vender no lo mueve: una salida no cambia lo que costó lo que queda.
--
-- POR QUÉ PROMEDIO Y NO POR LOTES. La mercancía es fungible. Al vender una
-- Mantequilla Sandía no hay forma de saber si salió una de las gratis o una de
-- las pagadas: están en la misma caja y son idénticas. Costear por lotes daría
-- un margen distinto por venta, pero esa precisión es una convención sobre cuál
-- unidad salió, no un dato. El promedio sí es exacto en el agregado, que es lo
-- que responde "cuánto gané de verdad".
--
-- BACKFILL. El promedio arranca en el costo de referencia de hoy: es lo único
-- que se sabe de lo que ya está en bodega. Las ventas ya hechas NO se tocan —
-- cada línea congela su `unitCostCOP` al cobrar, así que el histórico financiero
-- no se mueve bajo los pies. El promedio empieza a contar desde acá.

-- AlterTable
ALTER TABLE "retail_products" ADD COLUMN     "avgCostCOP" INTEGER;

-- Backfill: lo que hay hoy se valora al último costo pagado, que es la única
-- referencia existente. Solo donde hay un costo: dejar 0 en un producto sin
-- costo cargado haría aparecer margen del 100% en cada venta.
UPDATE "retail_products"
SET "avgCostCOP" = "costCOP"
WHERE "costCOP" > 0;
