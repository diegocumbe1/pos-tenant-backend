-- Por qué canal entró una venta o un gasto, y de qué borrador salió.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo agrega dos columnas NULL a `retail_sales` y dos a `expenses`, sin default
--     ni reescritura. NULL = se registró en la pantalla, como todo lo que ya existe.
--   · Idempotente: IF NOT EXISTS.

ALTER TABLE "retail_sales" ADD COLUMN IF NOT EXISTS "capturedVia" "AssistantChannel";
ALTER TABLE "retail_sales" ADD COLUMN IF NOT EXISTS "agentProposalId" TEXT;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "capturedVia" "AssistantChannel";
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "agentProposalId" TEXT;
