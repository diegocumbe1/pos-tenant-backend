-- Retail: de qué fecha de vencimiento salió cada unidad vendida o entregada.
-- Ver docs/PLAN_RETAIL_AJUSTES_OCTUBRE_2026.md (pos-system) §1.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AGREGA dos columnas JSONB NULL, sin default: no reescribe filas.
--   · Las ventas y entregas existentes quedan en NULL = "anterior al cambio";
--     al anularlas, la unidad vuelve a su lote por reconstrucción, como hoy.
--   · Idempotente: IF NOT EXISTS.

ALTER TABLE "retail_sale_items" ADD COLUMN IF NOT EXISTS "lotAllocations" JSONB;
ALTER TABLE "retail_sale_deliveries" ADD COLUMN IF NOT EXISTS "lotAllocations" JSONB;
