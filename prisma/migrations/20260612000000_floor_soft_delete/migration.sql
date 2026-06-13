-- Soft-delete (papelera) para áreas y mesas.
-- Additive: agrega columna deletedAt nullable + índice. Sin cambios de datos.

ALTER TABLE "areas" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "restaurant_tables" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "areas_deletedAt_idx" ON "areas" ("deletedAt");
CREATE INDEX IF NOT EXISTS "restaurant_tables_deletedAt_idx" ON "restaurant_tables" ("deletedAt");
