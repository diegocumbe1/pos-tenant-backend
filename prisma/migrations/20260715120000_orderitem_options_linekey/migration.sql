-- OrderItem / KitchenTicketItem: identidad por línea (lineKey) + opciones del ítem
-- (notes/additions/modifiers). Permite el mismo producto en varias líneas con
-- distintas notas/opciones y que esas notas lleguen a la comanda y se persistan.

-- 1) Columnas nuevas (lineKey nullable temporalmente para poder backfillear).
ALTER TABLE "order_items"
  ADD COLUMN "lineKey"   TEXT,
  ADD COLUMN "notes"     TEXT,
  ADD COLUMN "additions" JSONB,
  ADD COLUMN "modifiers" JSONB;

ALTER TABLE "kitchen_ticket_items"
  ADD COLUMN "lineKey"   TEXT,
  ADD COLUMN "notes"     TEXT,
  ADD COLUMN "additions" JSONB,
  ADD COLUMN "modifiers" JSONB;

-- 2) Backfill: filas existentes usan el productId como lineKey (eran únicas por
--    (orden, producto) / (ticket, producto), así que el nuevo unique se respeta).
UPDATE "order_items"         SET "lineKey" = "productId" WHERE "lineKey" IS NULL;
UPDATE "kitchen_ticket_items" SET "lineKey" = "productId" WHERE "lineKey" IS NULL;

-- 3) Ahora lineKey es obligatorio.
ALTER TABLE "order_items"         ALTER COLUMN "lineKey" SET NOT NULL;
ALTER TABLE "kitchen_ticket_items" ALTER COLUMN "lineKey" SET NOT NULL;

-- 4) Reemplazar el unique por producto por unique por línea.
DROP INDEX IF EXISTS "order_items_orderId_productId_key";
DROP INDEX IF EXISTS "kitchen_ticket_items_ticketId_productId_key";

CREATE UNIQUE INDEX "order_items_orderId_lineKey_key"
  ON "order_items" ("orderId", "lineKey");
CREATE UNIQUE INDEX "kitchen_ticket_items_ticketId_lineKey_key"
  ON "kitchen_ticket_items" ("ticketId", "lineKey");
