-- Add structured event metadata for order analytics and exact timeline replay.
ALTER TYPE "OrderEventType" ADD VALUE IF NOT EXISTS 'ITEM_UPDATED';
ALTER TYPE "OrderEventType" ADD VALUE IF NOT EXISTS 'ITEM_REMOVED';

ALTER TABLE "order_events" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

CREATE INDEX IF NOT EXISTS "order_events_tenantId_type_at_idx"
  ON "order_events"("tenantId", "type", "at");

CREATE INDEX IF NOT EXISTS "order_events_orderId_at_idx"
  ON "order_events"("orderId", "at");
