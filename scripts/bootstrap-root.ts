import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';

/**
 * Crea (o reusa) un usuario ROOT en Supabase + la fila local en `users`.
 * Uso:
 *   npm run bootstrap:root -- --email you@domain.com --name "Tu Nombre"
 *   npm run bootstrap:root -- --email you@domain.com --name "Tu" --password "Secret123!"
 *
 * Idempotente: si el email ya existe, refresca app_metadata, asegura la fila
 * local y (si se pasa --password) actualiza el password.
 *
 * Cuando se pasa --password no se genera magic link: el usuario queda listo
 * para hacer `POST /auth/login` directamente con email + password.
 */

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const email = arg('--email');
  const name = arg('--name') ?? 'Root';
  const password = arg('--password');
  if (!email) {
    console.error('Missing --email');
    process.exit(1);
  }
  if (password && password.length < 8) {
    console.error('Password must be at least 8 characters');
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const prisma = new PrismaClient();

  const rootRole = await prisma.role.findFirst({
    where: { tenantId: null, code: 'ROOT' },
  });
  if (!rootRole) {
    console.error('ROOT role missing — run `npm run db:seed` first');
    process.exit(1);
  }

  // 1) Encontrar o crear en Supabase
  let supabaseUserId: string | null = null;

  // listUsers no tiene filtro por email directo — paginamos
  const { data: list, error: listErr } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (listErr) throw new Error(`listUsers failed: ${listErr.message}`);
  const existing = list.users.find((u) => u.email === email);
  if (existing) {
    supabaseUserId = existing.id;
    console.log(`ℹ️  Reusing existing Supabase user ${supabaseUserId}`);
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      ...(password ? { password } : {}),
      app_metadata: { isRoot: true, roleId: rootRole.id, tenantId: null },
    });
    if (error) throw new Error(`createUser failed: ${error.message}`);
    supabaseUserId = data.user!.id;
    console.log(`✅ Created Supabase user ${supabaseUserId}`);
  }

  // 2) Sincronizar app_metadata (y password si se pasó)
  await supabase.auth.admin.updateUserById(supabaseUserId, {
    app_metadata: { isRoot: true, roleId: rootRole.id, tenantId: null },
    ...(password ? { password, email_confirm: true } : {}),
  });
  if (password) console.log('🔐 Password set');

  // 3) Crear fila local
  await prisma.user.upsert({
    where: { id: supabaseUserId },
    // ROOT es la identidad de plataforma absoluta → también es platform admin
    // (entra al backoffice /platform/*). Ver docs/BACKOFFICE_ARCHITECTURE.md §1.
    update: { roleId: rootRole.id, name, isActive: true, isPlatformAdmin: true },
    create: {
      id: supabaseUserId,
      tenantId: null,
      email,
      name,
      roleId: rootRole.id,
      isPlatformAdmin: true,
      invitedAt: new Date(),
      passwordSetAt: new Date(), // ROOT se considera ya establecido
    },
  });

  // 4) Si no se pasó password, generar magic link para el primer login.
  //    Con password ya seteado, no es necesario.
  let magicLink: string | undefined;
  if (!password) {
    const { data: link, error: linkErr } =
      await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: {
          redirectTo:
            process.env.SUPABASE_INVITE_REDIRECT_TO ??
            'http://localhost:3000/auth/accept-invite',
        },
      });
    if (linkErr) throw new Error(`generateLink failed: ${linkErr.message}`);
    magicLink = link.properties?.action_link;
  }

  console.log('\n🎉 ROOT ready.');
  console.log(`   Email: ${email}`);
  console.log(`   User ID: ${supabaseUserId}`);
  if (password) {
    console.log('   Login: POST /api/v1/auth/login con el password proporcionado.');
  } else {
    console.log(`   Magic link: ${magicLink ?? '(not generated)'}`);
    console.log('\nAbrelo en el frontend para setear password y empezar a usar.');
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
