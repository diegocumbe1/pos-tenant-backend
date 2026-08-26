-- Un pedido al proveedor se paga en varios giros, no en uno.
--
-- EL CASO REAL. Se abona al hacer el pedido y se completa cuando llega. O el
-- pedido crece —se agregan 10 unidades— y se gira lo nuevo días después. Hasta
-- ahora `expenseId` era un solo id: el segundo pago solo podía entrar pisando
-- al primero (dejando el gasto original huérfano y el pedido diciendo que lo
-- pagó el giro nuevo) o quedándose suelto en Finanzas sin enlace.
--
-- POR QUÉ NO SE EDITA EL GASTO ORIGINAL. Base caja: un gasto representa plata
-- que salió un día concreto. Sumarle el segundo pago al gasto del día 20 infla
-- el flujo de caja del 20 y deja vacío el del 24 — dos días mienten en vez de
-- cero. Cada giro es su propio gasto, con su propia fecha.
--
-- POR QUÉ ARRAYS Y NO UNA TABLA PUENTE. El enlace no tiene atributos propios:
-- el monto, la fecha y la categoría ya viven en `expenses`. Una tabla puente
-- solo agregaría un join a cada listado de la pantalla de pedidos.
--
-- POR QUÉ SIGUEN SEPARADOS MERCANCÍA Y ENVÍO. Además de que el flete se mira
-- como línea propia en Finanzas, tener el array de mercancía aparte permite
-- responder "¿este pedido ya tiene pago registrado?" con un length, sin cargar
-- los gastos. Ese aviso —plata que salió y no aparece— no se puede quedar en
-- blanco porque una consulta a Finanzas falle.
--
-- Sin FK, igual que antes: `expenses` es transversal a las verticales y un
-- mismo gasto cubre varias líneas de un pedido conjunto.

-- AlterTable
ALTER TABLE "retail_purchase_items" ADD COLUMN     "expenseIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "shippingExpenseIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill: el enlace único que ya existía pasa a ser el primer pago del
-- pedido. NULL se traduce a lista vacía, que significa lo mismo que antes
-- significaba NULL: todavía no se registró.
UPDATE "retail_purchase_items"
SET "expenseIds" = ARRAY["expenseId"]
WHERE "expenseId" IS NOT NULL;

UPDATE "retail_purchase_items"
SET "shippingExpenseIds" = ARRAY["shippingExpenseId"]
WHERE "shippingExpenseId" IS NOT NULL;

-- DropColumn
ALTER TABLE "retail_purchase_items" DROP COLUMN "expenseId",
DROP COLUMN "shippingExpenseId";
