import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { createDemoTenant } from './demo/create-demo-tenant';

/**
 * Crea (o reinicia) la demo de un negocio nuevo, SOLO en la base local.
 *
 *   npm run demo:new -- --preset gimnasio --name "KallpaBox" --create-auth --password 'Demo2026!'
 *
 * Flags:
 *   --name <texto>       Nombre del negocio (obligatorio)
 *   --preset <id>        gimnasio | crossfit — ver scripts/demo/presets
 *   --address / --city / --neighborhood / --tagline   Datos que se ven en la reserva pública
 *   --email <correo>     Correo del dueño. Por defecto demo.<slug>@uselynko.com
 *   --create-auth        Crea el usuario en Supabase Auth (el login pasa por ahí)
 *   --password <clave>   Clave del dueño (con --create-auth)
 *   --plan <BASIC|PRO|PREMIUM>   Por defecto PREMIUM
 *
 * El logo no se pide aquí: se sube después desde Ajustes con la cuenta iniciada.
 * Volver a correr el mismo --name reinicia esa demo desde cero.
 */

// Prisma ya pudo haber leído `.env` (producción) al importarse: `.env.local` debe
// ganar a la fuerza. Después `.env` solo completa lo que falte.
config({ path: '.env.local', override: true });
config({ path: '.env' });

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 || i === process.argv.length - 1 ? undefined : process.argv[i + 1];
}

async function main() {
  const name = arg('--name');
  if (!name) throw new Error('Falta --name "Nombre del negocio".');
  const plan = (arg('--plan') ?? 'PREMIUM') as 'BASIC' | 'PRO' | 'PREMIUM';
  if (!['BASIC', 'PRO', 'PREMIUM'].includes(plan)) throw new Error('--plan debe ser BASIC, PRO o PREMIUM.');

  // La misma URL que revisa el guard (localhost), no la que Prisma haya leído de `.env`.
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    console.log(`→ Creando demo "${name}"…`);
    const r = await createDemoTenant(prisma, {
      name,
      preset: arg('--preset') ?? 'gimnasio',
      ownerEmail: arg('--email'),
      address: arg('--address'),
      city: arg('--city'),
      neighborhood: arg('--neighborhood'),
      tagline: arg('--tagline'),
      createAuth: process.argv.includes('--create-auth'),
      password: arg('--password') ?? process.env.DEMO_PASSWORD,
      plan,
    });
    for (const line of r.summary) console.log(`  ✓ ${line}`);
    console.log('');
    console.log(`Listo. Entra con:   ${r.ownerEmail}`);
    console.log(`Reserva pública:    ${r.bookingPath}`);
    console.log('Logo: súbelo después desde Ajustes (no es obligatorio).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
