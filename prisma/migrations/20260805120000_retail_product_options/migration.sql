-- Opciones de presentación del producto (color, talla, ...). Aditiva y anulable:
-- los productos existentes quedan en NULL = sin opciones, y el catálogo se ve
-- exactamente igual que antes hasta que el admin configure alguna.
-- AlterTable
ALTER TABLE "retail_products" ADD COLUMN     "options" JSONB;
