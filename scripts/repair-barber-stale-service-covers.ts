/**
 * Saca de la galería pública las portadas VIEJAS de los servicios de barbería.
 *
 * EL DAÑO
 * -------
 * La pantalla de Servicios solo maneja una portada por servicio. Cada vez que
 * el dueño la cambiaba, el backend degradaba la anterior a kind="gallery" pero
 * la dejaba con showInPublicGallery=true. Resultado: el sitio publicado mostraba
 * todas las portadas históricas (varias "Baby Liner" casi iguales, algunas rotas)
 * mientras el editor y su vista previa solo mostraban la portada actual.
 * `applyPrimaryAsset` ya no lo hace; este script limpia lo acumulado.
 *
 * QUÉ TOCA
 * --------
 * Solo `barber_service_assets.showInPublicGallery` → false, en assets que:
 *   - no son la portada (kind != "primary"), y
 *   - no son la URL de `barber_services.primaryImageUrl`.
 * No borra filas ni archivos: el histórico queda, solo deja de publicarse.
 *
 *   Uso:
 *     npx ts-node scripts/repair-barber-stale-service-covers.ts [--tenant <id>]
 *     ... --apply            (escribe; sin esto es dry-run)
 *     ... --apply --prod     (obligatorio si la base no es local)
 */
import { writeFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';

// ⚠️ `@prisma/client` auto-carga `.env` — el de PRODUCCIÓN — y NO `.env.local`.
const APPLY = process.argv.includes('--apply');
const ALLOW_PROD = process.argv.includes('--prod');

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const TENANT = argValue('--tenant');

const DB_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const DB_HOST =
  DB_URL.replace(/^.*@/, '').replace(/[/?].*$/, '') || '(desconocido)';
const IS_LOCAL = /^(localhost|127\.0\.0\.1|host\.docker\.internal)(:|$)/.test(
  DB_HOST,
);

if (APPLY && !IS_LOCAL && !ALLOW_PROD) {
  console.error(
    `\n✗ Cancelado: ibas a ESCRIBIR en ${DB_HOST}, que no es local.\n` +
      `  Añade --prod de forma deliberada si de verdad es producción.\n`,
  );
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

async function main() {
  console.log(`\n→ Base: ${DB_HOST}`);
  console.log(`→ Tenant: ${TENANT ?? 'todos'}`);
  console.log(APPLY ? '→ Modo: APLICAR\n' : '→ Modo: dry-run (sin --apply)\n');

  const assets = await prisma.barberServiceAsset.findMany({
    where: {
      showInPublicGallery: true,
      kind: { not: 'primary' },
      ...(TENANT ? { tenantId: TENANT } : {}),
    },
    select: {
      id: true,
      tenantId: true,
      url: true,
      kind: true,
      service: { select: { id: true, name: true, primaryImageUrl: true } },
    },
    orderBy: [{ tenantId: 'asc' }, { serviceId: 'asc' }, { createdAt: 'asc' }],
  });

  const stale = assets.filter((asset) => asset.url !== asset.service.primaryImageUrl);

  if (stale.length === 0) {
    console.log('No hay portadas viejas publicadas. Nada que corregir.\n');
    return;
  }

  for (const asset of stale) {
    console.log(`  ${asset.tenantId}  ${asset.service.name.padEnd(28)}  ${asset.url}`);
  }
  console.log(`\n${stale.length} asset(s) saldrían de la galería pública.`);

  if (!APPLY) {
    console.log('Dry-run: no se escribió nada. Repite con --apply.\n');
    return;
  }

  const backup = `repair-barber-stale-service-covers.${Date.now()}.json`;
  writeFileSync(backup, JSON.stringify(stale, null, 2));
  console.log(`Respaldo: ${backup}`);

  const result = await prisma.barberServiceAsset.updateMany({
    where: { id: { in: stale.map((asset) => asset.id) } },
    data: { showInPublicGallery: false },
  });
  console.log(`✓ ${result.count} asset(s) actualizados.\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
