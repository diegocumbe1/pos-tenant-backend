-- Cambiar el cliente de una venta ya registrada es un hecho del histórico.
--
-- POR QUÉ TIENE SU PROPIO TIPO. Reescribe el histórico de DOS clientes —a uno le
-- sale una compra y a otro le entra— y eso es justo lo que después nadie sabe
-- explicar cuando el total gastado de alguien no cuadra. Metido dentro de 'NOTE'
-- quedaría indistinguible de una anotación cualquiera y no se podría filtrar.
--
-- Va en su propio archivo porque un valor de enum no se puede USAR en la misma
-- transacción en que se agrega.
ALTER TYPE "RetailSaleEventKind" ADD VALUE IF NOT EXISTS 'CUSTOMER_CHANGED';
