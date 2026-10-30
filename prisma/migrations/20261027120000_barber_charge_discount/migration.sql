-- Descuento del cobro de barbería/gimnasio. Aditiva e idempotente.
ALTER TABLE "barber_charges" ADD COLUMN IF NOT EXISTS "discountCOP" INTEGER NOT NULL DEFAULT 0;
