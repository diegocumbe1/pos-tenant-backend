-- El zip de sesión de WhatsApp (~30MB) pasa a Supabase Storage (bucket privado).
-- En Postgres queda solo el índice: path del objeto + hash del último backup.
--
-- IMPORTANTE: antes de aplicar esta migración hay que mover el blob existente a
-- Storage, o la sesión emparejada se pierde y habrá que escanear el QR de nuevo:
--   npm run migrate:wa-session
--
-- Después de aplicarla, recuperar el espacio (DROP COLUMN no libera el TOAST):
--   VACUUM FULL whatsapp_sessions;

-- IF NOT EXISTS: el script de migración ya crea estas dos columnas para poder
-- registrar el path antes de que se borre el blob.
ALTER TABLE "whatsapp_sessions" ADD COLUMN IF NOT EXISTS "storagePath" TEXT;
ALTER TABLE "whatsapp_sessions" ADD COLUMN IF NOT EXISTS "dataHash" TEXT;
ALTER TABLE "whatsapp_sessions" DROP COLUMN IF EXISTS "data";
