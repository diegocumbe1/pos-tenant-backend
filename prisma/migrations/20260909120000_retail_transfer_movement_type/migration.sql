-- El traslado entre bodegas, como tipo de movimiento del kardex.
--
-- Va solo en su propio archivo porque un valor de enum recién agregado no se
-- puede USAR en la misma transacción en que se agrega, y la migración que sigue
-- necesita poder escribirlo.
ALTER TYPE "RetailStockMovementType" ADD VALUE IF NOT EXISTS 'TRANSFER';
