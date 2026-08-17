/**
 * Repara el costo unitario de los ingredientes dañados por el bug de valoración.
 *
 * EL DAÑO
 * -------
 * `netUnitCost` se recalculaba como `totalPurchaseCost / stockRestante` en cada
 * movimiento, pero `totalPurchaseCost` nunca bajaba al consumir. El costo por
 * unidad subía con cada venta. En la base de producción quedaron 71 de 111
 * ingredientes activos inflados (factor promedio 2,3×, máximo 34×).
 *
 * DE DÓNDE SALE EL VALOR CORRECTO
 * -------------------------------
 * Del `unitCost` del último movimiento de COMPRA o PRODUCCIÓN. Es el precio que
 * realmente se pagó, queda escrito en el movimiento y NUNCA se recalcula, así
 * que es el único dato que el bug no pudo tocar.
 *
 * `grossUnitCost` NO sirve como fuente: sobrevivió solo en los ingredientes que
 * únicamente pasaron por `sendToKitchen`/`voidOrder` (que no lo escribían). Los
 * que pasaron por `createMovement` lo tienen igual de inflado. El contraejemplo
 * que lo demuestra es Cerveza Águila botella: `grossUnitCost` 24.563 contra una
 * última compra de 2.233 — el mismo precio que su gemela Poker botella.
 *
 * Verificado contra datos reales — Cerveza Poker botella:
 *   última compra 2.233 · precio de venta 4.000 · targetMarginPct 44
 *   (4000 − 2233) / 4000 = 44,2 %  ← cuadra con el objetivo capturado a mano
 *
 * Si un ingrediente no tiene ningún movimiento con precio se reporta sin tocar:
 * es preferible dejarlo visible a inventarle un costo.
 *
 *   Uso:   npx ts-node scripts/repair-ingredient-costs.ts [--apply]
 *   Sin `--apply` solo muestra qué haría (dry-run por defecto).
 */
import { PrismaClient } from '@prisma/client';
import { convertQuantity } from '../src/restaurant/modules/inventory/unit-conversion';

// ⚠️ `@prisma/client` auto-carga `.env` — el de PRODUCCIÓN — y NO `.env.local`.
// La precedencia de `prisma.config.ts` que protege a `npx prisma ...` no aplica
// aquí: un script suelto con ts-node apunta a producción por defecto.
//
// Por eso escribir exige DOS cosas: `--apply` y, si el host no es local,
// `--prod`. Sin la segunda el script se niega y dice a dónde iba a escribir.
const APPLY = process.argv.includes('--apply');
const ALLOW_PROD = process.argv.includes('--prod');

const DB_URL = process.env.DATABASE_URL ?? '';
const DB_HOST = DB_URL.replace(/^.*@/, '').replace(/[/?].*$/, '') || '(desconocido)';
const IS_LOCAL = /^(localhost|127\.0\.0\.1|host\.docker\.internal)(:|$)/.test(DB_HOST);

if (APPLY && !IS_LOCAL && !ALLOW_PROD) {
  console.error(
    `\n✗ Cancelado: ibas a ESCRIBIR en ${DB_HOST}, que no es local.\n` +
      `  Para la réplica:   DATABASE_URL=$(grep '^DATABASE_URL' .env.local | cut -d= -f2- | tr -d '"') npx ts-node ${process.argv[1]} --apply\n` +
      `  Para producción:   añade --prod de forma deliberada.\n`,
  );
  process.exit(1);
}

const prisma = new PrismaClient();

const money = (n: number) =>
  new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(n);

async function main() {
  const ingredients = await prisma.ingredient.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
  });

  const repaired: string[] = [];
  const skipped: string[] = [];

  for (const ing of ingredients) {
    // El precio realmente pagado en la última entrada. Una preparación se
    // "compra" produciéndola, por eso PRODUCTION cuenta igual que PURCHASE.
    const lastEntry = await prisma.stockMovement.findFirst({
      where: {
        ingredientId: ing.id,
        type: { in: ['PURCHASE', 'PRODUCTION'] },
        unitCost: { gt: 0 },
      },
      orderBy: { createdAt: 'desc' },
      select: { unitCost: true, type: true, createdAt: true },
    });

    // `grossUnitCost` solo como último recurso: en los ingredientes que pasaron
    // por `createMovement` también quedó inflado.
    const unitCost = lastEntry?.unitCost ?? ing.grossUnitCost;
    const source = lastEntry
      ? `última ${lastEntry.type === 'PURCHASE' ? 'compra' : 'producción'}`
      : 'grossUnitCost (sin movimientos con precio)';

    if (!(unitCost > 0)) {
      skipped.push(`  ${ing.name} — sin costo recuperable, se deja como está`);
      continue;
    }

    const stock = ing.currentStock;
    const usableRatio = 1 - ing.technicalWastePercentage / 100;
    const netUsableQuantity =
      stock > 0
        ? convertQuantity(stock, ing.purchaseUnit, ing.recipeUnit, ing) *
          usableRatio
        : 0;
    const totalPurchaseCost = Math.max(0, stock * unitCost);
    const netUnitCost =
      netUsableQuantity > 0
        ? totalPurchaseCost / netUsableQuantity
        : // Sin stock se conserva el costo por unidad de receta derivado del de
          // compra: agotado no es gratis.
          unitCost /
          (convertQuantity(1, ing.purchaseUnit, ing.recipeUnit, ing) *
            usableRatio || 1);

    const changed =
      Math.abs(netUnitCost - ing.netUnitCost) > 0.01 ||
      Math.abs(totalPurchaseCost - ing.totalPurchaseCost) > 0.01 ||
      Math.abs(unitCost - ing.grossUnitCost) > 0.01;

    if (!changed) continue;

    const factor = netUnitCost > 0 ? ing.netUnitCost / netUnitCost : 0;
    const diagnosis =
      factor > 1.05
        ? `${factor.toFixed(1)}× inflado`
        : factor > 0.95
          ? 'ajuste menor'
          : ing.netUnitCost === 0
            ? 'estaba en 0'
            : `estaba ${(1 / factor).toFixed(1)}× bajo`;
    repaired.push(
      `  ${ing.name.padEnd(30)} ${money(ing.netUnitCost).padStart(9)} → ${money(
        netUnitCost,
      ).padStart(9)}  ${diagnosis.padEnd(18)} ${source}`,
    );

    if (APPLY) {
      await prisma.ingredient.update({
        where: { id: ing.id },
        data: {
          totalPurchaseCost,
          grossUnitCost: unitCost,
          netUnitCost,
          netUsableQuantity,
          grossStockQuantity: stock,
        },
      });
    }
  }

  console.log(
    `\n${APPLY ? 'APLICADO' : 'DRY-RUN (usa --apply para escribir)'} en ${DB_HOST} — ${
      ingredients.length
    } ingredientes activos revisados\n`,
  );
  console.log(`Corregidos: ${repaired.length}`);
  if (repaired.length) console.log(repaired.join('\n'));
  if (skipped.length) {
    console.log(`\nSin costo recuperable: ${skipped.length}`);
    console.log(skipped.join('\n'));
  }
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
