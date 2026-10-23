import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  InMoveExport,
  syncInMoveAthletes,
} from '../src/barber/modules/integrations/inmove/inmove-sync';

/**
 * Carga los deportistas de In Move como clientes, desde un archivo exportado.
 *
 * Es la MISMA lógica del botón "Sincronizar con In Move" de Ajustes (ver
 * inmove-sync.ts): se puede correr las veces que haga falta, no duplica, y lo
 * que el botón haga después parte de lo que esto deje.
 *
 * SIEMPRE SE CORRE PRIMERO EN SIMULACIÓN: sin `--commit` imprime el reporte y
 * no escribe nada.
 *
 *   1) En In Move:
 *        node --experimental-strip-types scripts/export-for-lynko.ts --out=./lynko-export.json
 *   2) Aquí (por correo del dueño, o con --tenant y --branch):
 *        npx ts-node scripts/import-inmove-customers.ts \
 *          --file=../projects/in-move/lynko-export.json \
 *          --email=in-move@yopmail.com \
 *          [--ficha-url=https://in-move.example.com]
 *      …y cuando el reporte se vea bien, otra vez con --commit
 *
 * La base es la de DATABASE_URL: para local, `DATABASE_URL=<local> npx ts-node …`
 * o con el .env.local cargado. Revisa a cuál apunta antes del --commit.
 */

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const FILE = arg('file');
const EMAIL = arg('email');
const FICHA_URL = arg('ficha-url');
const COMMIT = process.argv.includes('--commit');

async function resolveScope(): Promise<{ tenantId: string; branchId: string }> {
  const tenantId = arg('tenant');
  const branchId = arg('branch');
  if (tenantId && branchId) return { tenantId, branchId };
  if (!EMAIL) {
    throw new Error('Falta --email=<correo del dueño> o --tenant y --branch');
  }
  const user = await prisma.user.findUnique({
    where: { email: EMAIL },
    select: {
      tenantId: true,
      tenant: { select: { vertical: { select: { code: true } } } },
      userBranches: { select: { branchId: true } },
    },
  });
  if (!user?.tenantId) throw new Error(`No hay un negocio para ${EMAIL}`);
  if (user.tenant?.vertical?.code !== 'barber') {
    throw new Error(`${EMAIL} no es de la vertical barber`);
  }
  const branches = user.userBranches.map((b) => b.branchId);
  if (branches.length !== 1) {
    throw new Error(
      `${EMAIL} tiene ${branches.length} sedes; pasa --branch=<id> explícito`,
    );
  }
  return { tenantId: user.tenantId, branchId: branches[0] };
}

async function main() {
  if (!FILE) throw new Error('Falta --file=<exportación de In Move>');
  const payload = JSON.parse(readFileSync(FILE, 'utf8')) as InMoveExport;
  const scope = await resolveScope();
  const dbHost = (process.env.DATABASE_URL ?? '').replace(/\/\/[^@]*@/, '//***@');

  console.log(`Base: ${dbHost}`);
  console.log(`Negocio: ${scope.tenantId} · sede ${scope.branchId}`);
  console.log(`Exportación de In Move: ${payload.exportedAt}\n`);

  const report = await syncInMoveAthletes(prisma, scope, payload, {
    commit: COMMIT,
    fichaBaseUrl: FICHA_URL,
  });

  const label = { create: 'CREAR', link: 'ENLAZAR', update: 'ACTUALIZAR', unchanged: 'igual' };
  for (const item of report.items) {
    const detail = item.changes.length ? ` (${item.changes.join(', ')})` : '';
    console.log(`  ${label[item.action].padEnd(10)} ${item.code}  ${item.name}${detail}`);
  }
  console.log(
    `\n${report.total} deportistas → ${report.created} nuevos, ${report.linked} enlazados por nombre, ` +
      `${report.updated} actualizados, ${report.unchanged} sin cambios.`,
  );
  if (report.withoutPhone) {
    console.log(`${report.withoutPhone} sin teléfono real: In Move no lo guarda; se completa en Lynko.`);
  }
  for (const m of report.missingInSource) {
    console.log(`Ya no viene de In Move (se deja como está): ${m.code} ${m.name}`);
  }
  console.log(COMMIT ? '\nGUARDADO.' : '\nSIMULACIÓN: no se escribió nada. Repite con --commit.');
}

main()
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
