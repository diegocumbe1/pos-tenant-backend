-- Faltantes y sobrantes del proveedor: separar "cuánto pedí" de "cuánto llegó".
--
-- EL CASO. Pedido del 20/08/2026 a CREA CON ARTE: se pidieron 24 Splash Corporal
-- y llegaron 12; se pidieron 12 Perfume Capilar y llegaron 24. Al marcar
-- recibido no quedó registrado en ninguna parte que faltaran 12 de uno y
-- sobraran 12 del otro, así que no había cómo saber si el proveedor quedó
-- debiendo mercancía o si había que pagarle lo que mandó de más.
--
-- LA CAUSA. `quantity` hacía DOS trabajos con un solo número: "cuánto le pedí"
-- y "cuánto me llegó". El servicio ejecutaba `quantity: received` al recibir y
-- sobrescribía. Desde ese instante la cantidad pedida no existía, y sin ella la
-- diferencia no se puede calcular ni hoy ni nunca.
--
-- De ahí salían tres cosas más:
--   · El total del pedido es `estimatedCostCOP * quantity`, así que el saldo
--     "Pagado X de Y" cambiaba de significado al recibir: un pedido pagado
--     completo podía amanecer con deuda sin que nadie hubiera girado un peso.
--   · El costo unitario pactado también se pisaba con el de la factura, así que
--     tampoco se podía ver que el proveedor hubiera cobrado a otro precio.
--   · El kardex sumaba lo que quedara en el diálogo, que venía pre-llenado con
--     lo pedido: confirmar sin mirar sumaba lo pedido, no lo que llegó.
--
-- CÓMO QUEDA. `quantity` solo significa lo pedido y ya no se toca al recibir.
-- Lo que llega va a `receivedQuantity`, y el costo real de la factura a
-- `receivedUnitCostCOP`. La diferencia (`receivedQuantity - quantity`) es
-- derivada y no se guarda; lo que sí se guarda es en qué queda esa diferencia,
-- que es lo que el negocio necesita perseguir.
--
-- NULL vs 0 EN `receivedQuantity`. NULL es "todavía no se ha recibido". 0 es
-- "se recibió y no llegó nada", que es un faltante total y un hecho distinto.
-- Por eso la columna es nullable y no tiene default.

-- CreateEnum
CREATE TYPE "RetailPurchaseVarianceResolution" AS ENUM ('PENDING', 'REORDERED', 'CREDITED', 'ACCEPTED');

-- AlterTable
ALTER TABLE "retail_purchase_items" ADD COLUMN     "receivedQuantity" INTEGER;
ALTER TABLE "retail_purchase_items" ADD COLUMN     "receivedUnitCostCOP" INTEGER;
ALTER TABLE "retail_purchase_items" ADD COLUMN     "varianceResolution" "RetailPurchaseVarianceResolution";
ALTER TABLE "retail_purchase_items" ADD COLUMN     "varianceNote" TEXT;

-- Backfill de lo ya recibido.
--
-- En esas líneas el número que quedó en `quantity` ES el recibido: el servicio
-- lo sobrescribió al recibir. Se copia a su casilla correcta.
--
-- LO PEDIDO DE ESAS LÍNEAS ES IRRECUPERABLE. Se destruyó en el momento en que se
-- pisó, y no hay otra fuente: el kardex registra cuántas unidades entraron, no
-- cuántas se habían pedido. Quedan entonces con pedido = recibido, o sea "sin
-- discrepancia", que es exactamente lo que el sistema creía hasta hoy. No es una
-- suposición nueva: es dejar el histórico como estaba, sin inventarle diferencias
-- que nadie puede verificar.
UPDATE "retail_purchase_items"
SET "receivedQuantity" = "quantity",
    "receivedUnitCostCOP" = "estimatedCostCOP"
WHERE "status" = 'RECEIVED';

-- Las dos líneas del caso real SÍ se conocen, así que se corrigen a mano: es la
-- única información que existe sobre lo que de verdad se pidió antes de que la
-- columna se pisara, y perderla sería empezar el arreglo con el dato malo.
--
-- Splash Corporal: se pidieron 24 y llegaron 12 → el proveedor debe 12.
--   `quantity` quedó en 24 (nunca se corrigió al recibir), así que lo pedido ya
--   está bien y solo hay que arreglar lo recibido, que el UPDATE de arriba dejó
--   en 24.
-- Perfume Capilar: se pidieron 12 y llegaron 24 → hay que pagarle 12 de más.
--   Acá `quantity` quedó en 12, que también es lo pedido; lo recibido son 24.
--
-- Acotado por proveedor y fecha para no tocar líneas homónimas de otros pedidos.
UPDATE "retail_purchase_items"
SET "receivedQuantity" = 12,
    "varianceResolution" = 'PENDING',
    "varianceNote" = 'Llegaron 12 de 24. Pendiente de reposición del proveedor.'
WHERE "status" = 'RECEIVED'
  AND "name" ILIKE '%Splash Corporal%'
  AND "receivedAt" >= DATE '2026-09-01'
  AND "receivedAt" <  DATE '2026-09-03';

UPDATE "retail_purchase_items"
SET "receivedQuantity" = 24,
    "varianceResolution" = 'PENDING',
    "varianceNote" = 'Llegaron 24 de 12. Pendiente de acordar el pago de las 12 de más.'
WHERE "status" = 'RECEIVED'
  AND "name" ILIKE '%Perfume Capilar%'
  AND "receivedAt" >= DATE '2026-09-01'
  AND "receivedAt" <  DATE '2026-09-03';

-- OJO: estas dos correcciones arreglan el REGISTRO del pedido, no el INVENTARIO.
-- El kardex ya sumó lo que se confirmó en su momento y esos movimientos no se
-- tocan desde aquí: reescribir un movimiento de inventario pasado dejaría el
-- kardex sin cuadrar contra el stock. El stock se corrige contando físicamente y
-- registrando un ajuste desde Inventario, que es lo que deja la traza correcta.

-- Índice para el estado de cuenta por proveedor: se consultan las líneas con
-- diferencia sin resolver, que son pocas dentro de un histórico grande.
CREATE INDEX "retail_purchase_items_tenantId_branchId_varianceResolution_idx"
  ON "retail_purchase_items"("tenantId", "branchId", "varianceResolution");
