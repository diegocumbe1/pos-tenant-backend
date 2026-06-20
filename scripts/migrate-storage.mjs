// Migra todos los objetos de un bucket de Storage entre dos proyectos Supabase.
// Uso:
//   OLD_URL=... OLD_KEY=... NEW_URL=... NEW_KEY=... BUCKET=lynko-assets \
//   node scripts/migrate-storage.mjs
//
// OLD_KEY / NEW_KEY = SERVICE ROLE keys (no anon). Lectura del viejo, escritura del nuevo.

import { createClient } from '@supabase/supabase-js';

const { OLD_URL, OLD_KEY, NEW_URL, NEW_KEY, BUCKET } = process.env;

for (const [k, v] of Object.entries({ OLD_URL, OLD_KEY, NEW_URL, NEW_KEY, BUCKET })) {
  if (!v) {
    console.error(`Falta la variable de entorno: ${k}`);
    process.exit(1);
  }
}

const old = createClient(OLD_URL, OLD_KEY, { auth: { persistSession: false } });
const neo = createClient(NEW_URL, NEW_KEY, { auth: { persistSession: false } });

const PAGE = 1000;

// Lista recursiva: Supabase devuelve archivos y "carpetas" (id === null) por prefijo.
async function listAll(prefix = '') {
  const out = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await old.storage
      .from(BUCKET)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`list ${prefix}: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        // carpeta → recursar
        out.push(...(await listAll(path)));
      } else {
        out.push(path);
      }
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

async function ensureBucket() {
  const { data: oldInfo } = await old.storage.getBucket(BUCKET);
  const { data: existing } = await neo.storage.getBucket(BUCKET);
  if (existing) {
    console.log(`Bucket "${BUCKET}" ya existe en destino.`);
    return;
  }
  const { error } = await neo.storage.createBucket(BUCKET, {
    public: oldInfo?.public ?? false,
    fileSizeLimit: oldInfo?.file_size_limit ?? undefined,
    allowedMimeTypes: oldInfo?.allowed_mime_types ?? undefined,
  });
  if (error) throw new Error(`createBucket: ${error.message}`);
  console.log(`Bucket "${BUCKET}" creado en destino (public=${oldInfo?.public ?? false}).`);
}

async function main() {
  await ensureBucket();

  console.log('Listando objetos del bucket origen...');
  const paths = await listAll();
  console.log(`Encontrados ${paths.length} objetos.`);

  let ok = 0;
  let fail = 0;
  for (const path of paths) {
    try {
      const { data: blob, error: dErr } = await old.storage.from(BUCKET).download(path);
      if (dErr) throw dErr;
      const buf = Buffer.from(await blob.arrayBuffer());
      const { error: uErr } = await neo.storage
        .from(BUCKET)
        .upload(path, buf, { upsert: true, contentType: blob.type || undefined });
      if (uErr) throw uErr;
      ok++;
      if (ok % 25 === 0) console.log(`  ${ok}/${paths.length}...`);
    } catch (e) {
      fail++;
      console.error(`  FALLO ${path}: ${e.message || e}`);
    }
  }

  console.log(`\nListo. Subidos: ${ok}, Fallidos: ${fail}, Total: ${paths.length}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
