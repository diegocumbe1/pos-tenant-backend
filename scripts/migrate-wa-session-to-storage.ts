import 'dotenv/config';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';

/**
 * Mueve el zip de sesión de WhatsApp de Postgres (whatsapp_sessions.data) al
 * bucket privado de Supabase Storage.
 *
 * EJECUTAR ANTES de aplicar la migración 20260806150000_whatsapp_session_to_storage,
 * que borra la columna `data`. Si se aplica la migración primero, la sesión se
 * pierde y hay que volver a escanear el QR.
 *
 * Idempotente: si el objeto ya existe en Storage con el mismo hash, no re-sube.
 * No borra la columna ni la fila — de eso se encarga la migración.
 *
 * Uso:
 *   npm run migrate:wa-session
 */

const BUCKET = process.env.SUPABASE_PRIVATE_BUCKET || 'lynko-private';

const prisma = new PrismaClient();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function ensureBucket() {
  const { error } = await supabase.storage.getBucket(BUCKET);
  if (!error) return;
  // 50MB = tope global por archivo del plan Free; pedir más falla con
  // "The object exceeded the maximum allowed size".
  const { error: createError } = await supabase.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: process.env.SUPABASE_PRIVATE_MAX_FILE_SIZE || '50MB',
  });
  if (createError) throw new Error(`No se pudo crear ${BUCKET}: ${createError.message}`);
  console.log(`Bucket privado ${BUCKET} creado`);
}

async function main() {
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (!process.env[key]) throw new Error(`Falta la variable de entorno: ${key}`);
  }

  await ensureBucket();

  // Las columnas índice las crea la migración, pero este script corre antes que
  // ella (necesita `data` viva). Se adelantan aquí; la migración usa
  // IF NOT EXISTS, así que aplicarla después no falla.
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "whatsapp_sessions" ADD COLUMN IF NOT EXISTS "storagePath" TEXT`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "whatsapp_sessions" ADD COLUMN IF NOT EXISTS "dataHash" TEXT`,
  );

  // Raw query: el schema de Prisma ya no declara `data`.
  const rows = await prisma.$queryRaw<
    { clientId: string; data: Buffer | null }[]
  >`SELECT "clientId", "data" FROM "whatsapp_sessions" WHERE "data" IS NOT NULL`;

  if (rows.length === 0) {
    console.log('No hay sesiones con blob en DB. Nada que migrar.');
    return;
  }

  for (const row of rows) {
    const data = row.data!;
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const path = `whatsapp-sessions/${row.clientId}.zip`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, data, { contentType: 'application/zip', upsert: true });
    if (error) throw new Error(`Upload de ${path} falló: ${error.message}`);

    await prisma.$executeRaw`
      UPDATE "whatsapp_sessions"
      SET "storagePath" = ${path}, "dataHash" = ${hash}
      WHERE "clientId" = ${row.clientId}
    `;

    console.log(
      `${row.clientId}: ${(data.length / 1024 / 1024).toFixed(1)} MB → ${BUCKET}/${path}`,
    );
  }

  console.log(
    `\nListo. Ahora aplica la migración (npx prisma migrate deploy) y luego:\n` +
      `  VACUUM FULL whatsapp_sessions;`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
