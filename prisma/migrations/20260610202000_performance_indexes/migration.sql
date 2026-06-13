-- Performance indexes for common multi-tenant filters.
-- Additive only: no data changes.

CREATE INDEX IF NOT EXISTS "products_tenantId_branchId_deletedAt_idx"
  ON "products" ("tenantId", "branchId", "deletedAt");

CREATE INDEX IF NOT EXISTS "orders_tenantId_branchId_status_createdAt_idx"
  ON "orders" ("tenantId", "branchId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "orders_tenantId_branchId_status_closedAt_idx"
  ON "orders" ("tenantId", "branchId", "status", "closedAt");

CREATE INDEX IF NOT EXISTS "orders_tenantId_branchId_tableId_status_idx"
  ON "orders" ("tenantId", "branchId", "tableId", "status");

CREATE INDEX IF NOT EXISTS "kitchen_tickets_tenantId_status_priority_sentAt_idx"
  ON "kitchen_tickets" ("tenantId", "status", "priority", "sentAt");

CREATE INDEX IF NOT EXISTS "payment_splits_tenantId_paidAt_idx"
  ON "payment_splits" ("tenantId", "paidAt");

CREATE INDEX IF NOT EXISTS "payment_splits_tenantId_orderId_paidAt_idx"
  ON "payment_splits" ("tenantId", "orderId", "paidAt");

CREATE INDEX IF NOT EXISTS "reservations_tenantId_branchId_status_scheduledAt_idx"
  ON "reservations" ("tenantId", "branchId", "status", "scheduledAt");

CREATE INDEX IF NOT EXISTS "expenses_tenantId_branchId_incurredAt_idx"
  ON "expenses" ("tenantId", "branchId", "incurredAt");

CREATE INDEX IF NOT EXISTS "printers_tenantId_branchId_target_isActive_idx"
  ON "printers" ("tenantId", "branchId", "target", "isActive");

CREATE INDEX IF NOT EXISTS "print_jobs_tenantId_branchId_status_createdAt_idx"
  ON "print_jobs" ("tenantId", "branchId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "cash_movements_type_reference_idx"
  ON "cash_movements" ("type", "reference");

CREATE INDEX IF NOT EXISTS "platform_expenses_incurredAt_currency_idx"
  ON "platform_expenses" ("incurredAt", "currency");

CREATE INDEX IF NOT EXISTS "platform_expenses_category_currency_incurredAt_idx"
  ON "platform_expenses" ("category", "currency", "incurredAt");
