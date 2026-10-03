-- Descuento del proveedor por pedido y "omitir gasto" para pedidos sin costo.
-- El descuento antes solo quedaba en la nota y el libro lo contaba como deuda.

ALTER TYPE "RetailSupplierLedgerKind" ADD VALUE IF NOT EXISTS 'DISCOUNT';

ALTER TABLE "retail_purchase_items"
  ADD COLUMN "discountCOP"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "expenseSkippedAt" TIMESTAMP(3),
  ADD COLUMN "expenseSkipNote"  TEXT;
