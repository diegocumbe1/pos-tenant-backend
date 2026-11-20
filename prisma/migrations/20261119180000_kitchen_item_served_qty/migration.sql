-- Entrega parcial: cuántas unidades de cada línea de una comanda ya están en la mesa.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo AÑADE una columna con valor por defecto 0: no reescribe datos ni cambia el significado de nada.
--   · Idempotente: IF NOT EXISTS.
--   · Las comandas que ya estaban SERVED siguen en SERVED; su servedQty queda en 0 y el código
--     no lo mira cuando la comanda completa ya está servida.

ALTER TABLE "kitchen_ticket_items" ADD COLUMN IF NOT EXISTS "servedQty" INTEGER NOT NULL DEFAULT 0;
