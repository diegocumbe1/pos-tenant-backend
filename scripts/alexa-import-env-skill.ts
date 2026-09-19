/**
 * Pasa la skill configurada por variables de entorno a la tabla `alexa_skills`.
 *
 * Se corre UNA vez, contra la base que corresponda, para no tener que volver a
 * activar por voz: conserva el hash de la frase, la cuenta de Amazon ya fijada
 * y la autorización vigente de `alexa_authorizations` si todavía no vence.
 *
 *   npm run alexa:import-env
 *
 * Después de esto, las variables ALEXA_* dejan de usarse: la skill se
 * administra desde el super-admin.
 */
import * as dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { isActivationHash } from '../src/integrations/alexa/activation-secret';

// Mismo orden que `src/load-env.ts`: `.env.local` primero, así el desarrollo
// apunta a la réplica de Docker. Sin `--prod` esto escribe en LOCAL, que es lo
// que se quiere al probar. Apuntar a producción tiene que ser deliberado.
const PROD = process.argv.includes('--prod');
if (!PROD) dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ path: '.env', quiet: true });

function env(key: string): string {
  return process.env[key]?.trim() ?? '';
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}`;
  } catch {
    return 'ilegible';
  }
}

const prisma = new PrismaClient();

async function main() {
  console.log(
    `Base de datos: ${hostOf(env('DATABASE_URL'))}${PROD ? '  (--prod)' : '  (local; usa --prod para producción)'}\n`,
  );
  const applicationId = env('ALEXA_SKILL_ID');
  const activationHash = env('ALEXA_ACTIVATION_SECRET_HASH');
  const actingUserId = env('ALEXA_LYNKO_USER_ID');
  const ttlDays = Number(env('ALEXA_AUTH_TTL_DAYS') || '7');

  if (!applicationId) throw new Error('Falta ALEXA_SKILL_ID.');
  if (!actingUserId) throw new Error('Falta ALEXA_LYNKO_USER_ID.');
  if (activationHash && !isActivationHash(activationHash)) {
    throw new Error(
      'ALEXA_ACTIVATION_SECRET_HASH no tiene formato scrypt-v1. Genera uno con `npm run alexa:hash`.',
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: actingUserId },
    select: { email: true, isPlatformAdmin: true },
  });
  if (!user) throw new Error(`El usuario ${actingUserId} no existe.`);

  // La fila vieja guarda la sesión vigente. Se conserva para no obligar a
  // reactivar por voz solo porque cambiamos de tabla.
  const previous = await prisma.alexaAuthorization.findFirst({
    orderBy: { updatedAt: 'desc' },
  });
  const stillValid =
    previous?.expiresAt && previous.expiresAt.getTime() > Date.now();

  const data = {
    label: 'Plataforma (importada de variables de entorno)',
    // Sin tenant: es la skill de super-admin, ve todos los negocios.
    tenantId: null,
    actingUserId,
    activationHash: activationHash || null,
    ttlDays:
      Number.isInteger(ttlDays) && ttlDays >= 1 && ttlDays <= 30 ? ttlDays : 7,
    alexaUserId: env('ALEXA_ALLOWED_USER_ID') || null,
    alexaDeviceId: env('ALEXA_ALLOWED_DEVICE_ID') || null,
    expiresAt: stillValid ? previous.expiresAt : null,
  };

  const skill = await prisma.alexaSkill.upsert({
    where: { applicationId },
    create: { applicationId, ...data },
    update: data,
  });

  console.log(`Skill registrada: ${skill.id}`);
  console.log(`  applicationId : ${skill.applicationId}`);
  console.log(`  usuario       : ${user.email}`);
  console.log(
    `  frase         : ${skill.activationHash ? 'definida' : 'FALTA'}`,
  );
  console.log(`  cuenta Alexa  : ${skill.alexaUserId ? 'fijada' : 'libre'}`);
  console.log(
    `  sesión        : ${skill.expiresAt ? `vigente hasta ${skill.expiresAt.toISOString()}` : 'hay que activar por voz'}`,
  );
  if (!user.isPlatformAdmin) {
    console.warn(
      '\n⚠ El usuario no es admin de plataforma: las consultas de plataforma van a ser rechazadas.',
    );
  }
}

main()
  .catch((error: Error) => {
    console.error(`\n✗ ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
