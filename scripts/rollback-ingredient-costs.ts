/**
 * Revierte `repair-ingredient-costs.ts` restaurando los costos desde la RÉPLICA.
 *
 * La réplica local es una copia exacta de producción tomada ANTES de la
 * reparación, y el arreglo no tocó ninguna cantidad de stock (verificado: 0
 * filas con `currentStock`/`grossStockQuantity` distinto). Por eso restaurar los
 * cuatro campos de costo desde la réplica devuelve producción al estado previo,
 * sin efectos colaterales.
 *
 * Solo restaura filas que existen en ambas bases y cuyo costo difiere.
 *
 *   Uso:
 *     npx ts-node scripts/rollback-ingredient-costs.ts            # dry-run
 *     npx ts-node scripts/rollback-ingredient-costs.ts --apply --prod
 *
 * Requiere que el contenedor de la réplica esté arriba (docker compose up -d).
 */
import { execFileSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const ALLOW_PROD = process.argv.includes('--prod');

const DB_URL = process.env.DATABASE_URL ?? '';
const DB_HOST = DB_URL.replace(/^.*@/, '').replace(/[/?].*$/, '') || '(desconocido)';
const IS_LOCAL = /^(localhost|127\.0\.0\.1|host\.docker\.internal)(:|$)/.test(DB_HOST);

if (APPLY && !IS_LOCAL && !ALLOW_PROD) {
  console.error(`\n✗ Cancelado: ibas a ESCRIBIR en ${DB_HOST}. Añade --prod.\n`);
  process.exit(1);
}

const CONTAINER = process.env.REPLICA_CONTAINER ?? 'lynko-db-local';
/** Campos de costo que se restauran. El stock NO se toca. */
const FIELDS = [
  'totalPurchaseCost',
  'grossUnitCost',
  'netUnitCost',
  'netUsableQuantity',
] as const;
/** Se lee además para la guardia: si el stock cambió, no se restaura esa fila. */
const GUARD = 'currentStock' as const;
const COLUMNS = [...FIELDS, GUARD] as const;

const prisma = new PrismaClient();

function readReplica(): Map<string, Record<(typeof COLUMNS)[number], number>> {
  const sql = `SELECT id||'|'||"${COLUMNS.join('"||\'|\'||"')}" FROM ingredients;`;
  const out = execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'lynko', '-d', 'postgres', '-tAc', sql],
    { encoding: 'utf8' },
  );
  const map = new Map<string, Record<(typeof COLUMNS)[number], number>>();
  for (const line of out.trim().split('\n')) {
    if (!line) continue;
    const [id, ...vals] = line.split('|');
    map.set(
      id,
      Object.fromEntries(
        COLUMNS.map((f, i) => [f, Number(vals[i])]),
      ) as Record<(typeof COLUMNS)[number], number>,
    );
  }
  return map;
}

async function main() {
  const replica = readReplica();
  const current = await prisma.ingredient.findMany({ orderBy: { name: 'asc' } });

  let restored = 0;
  let stockGuard = 0;
  for (const ing of current) {
    const before = replica.get(ing.id);
    if (!before) continue;

    const differs = FIELDS.some(
      (f) => Math.abs((before[f] ?? 0) - (ing[f] as number)) > 0.01,
    );
    if (!differs) continue;

    // Guardia: si hubo ventas desde el dump, la réplica ya no representa el
    // estado previo de esta fila y restaurar su costo sería inventar un valor.
    if (Math.abs(before[GUARD] - ing.currentStock) > 1e-6) {
      stockGuard++;
      continue;
    }

    console.log(
      `  ${ing.name.padEnd(32)} netUnitCost ${ing.netUnitCost.toFixed(2).padStart(10)} → ${before.netUnitCost
        .toFixed(2)
        .padStart(10)}`,
    );
    restored++;

    if (APPLY) {
      await prisma.ingredient.update({
        where: { id: ing.id },
        data: {
          totalPurchaseCost: before.totalPurchaseCost,
          grossUnitCost: before.grossUnitCost,
          netUnitCost: before.netUnitCost,
          netUsableQuantity: before.netUsableQuantity,
        },
      });
    }
  }

  console.log(
    `\n${APPLY ? 'RESTAURADO' : 'DRY-RUN (usa --apply --prod)'} en ${DB_HOST} — ${restored} ingredientes`,
  );
  if (stockGuard) console.log(`Omitidos por stock cambiado: ${stockGuard}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
