-- Enlace entre un pedido a proveedor y los gastos de Finanzas que lo pagaron.
--
-- Hasta ahora el vínculo era texto libre en la nota del pedido ("[Pago pedido]
-- … Pagado: $348.000"): Finanzas no sabía de qué pedido salía un gasto, y el
-- pedido no sabía si su gasto había quedado registrado. Estas dos columnas son
-- el mismo patrón que `stockMovementId`, que ya guarda el id del movimiento de
-- inventario generado al recibir.
--
-- Sin FK a propósito: `expenses` es transversal a las verticales (igual que
-- User) y un mismo gasto cubre varias líneas de un pedido conjunto, así que la
-- relación es de muchos a uno y no debe borrar líneas en cascada.
--
-- Mercancía y envío van en columnas separadas porque el flete se paga aparte,
-- se conoce después y el negocio quiere verlo como línea propia en Finanzas.
--
-- NULL = ese gasto todavía no se registró. Nunca significa "costó cero". Todos
-- los pedidos existentes quedan en NULL y se pueden enlazar a mano desde la UI.

-- AlterTable
ALTER TABLE "retail_purchase_items" ADD COLUMN     "expenseId" TEXT,
ADD COLUMN     "shippingExpenseId" TEXT;
