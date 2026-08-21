/**
 * Corrige el costo CONGELADO de las ventas de un producto de tienda.
 *
 * EL DAÑO
 * -------
 * Un producto quedó cargado con un costo de compra que nunca fue cierto (caso
 * real: "Mantequillas Mini" con 1.800, cuando en realidad llegan de regalo por
 * comprar al por mayor las grandes, o sea que cuestan 0). Cada venta congela el
 * costo del producto en ese momento —`unitCostCOP`, ver `freeze_cost_on_sale`—
 * así que corregir el catálogo NO arregla lo ya vendido: esas ventas siguen
 * reportando una utilidad menor a la real y el margen del período queda mal.
 *
 * POR QUÉ ESTO SÍ ES LEGÍTIMO
 * ---------------------------
 * Congelar el costo existe para que reprecios FUTUROS no reescriban el pasado.
 * Aquí no se está reescribiendo la historia: se está corrigiendo un dato que
 * se registró mal desde el principio. El producto nunca costó 1.800.
 *
 * Por eso el script exige `--from` (el costo equivocado que se espera encontrar)
 * además de `--to`: solo toca las líneas que efectivamente tienen ese valor. Si
 * una venta congeló otro costo —porque en su momento SÍ era otro— se reporta y
 * se deja intacta, en vez de aplanarlo todo al mismo número.
 *
 * QUÉ TOCA, Y POR QUÉ LOS TRES
 * ----------------------------
 *   1. `retail_sale_items.unitCostCOP` — el detalle que se ve en la venta.
 *   2. `retail_sales.costCOP`          — de aquí sale el margen de Finanzas.
 *   3. `retail_stock_movements.unitCostCOP` de los movimientos SALE de ese
 *      producto — la valoración del kardex.
 *
 * Corregir solo el primero dejaría el margen de Finanzas igual de mal, porque
 * el resumen suma `retail_sales.costCOP`, no las líneas.
 *
 * NO toca cantidades, ni stock, ni precios de venta, ni fechas, ni el estado de
 * la venta. Solo costos.
 *
 * TRAZABILIDAD
 * ------------
 * Corregir plata sin dejar rastro es justo lo que no se debe hacer. Cada venta
 * tocada recibe una nota con la fecha, el costo anterior, el nuevo y el motivo,
 * visible en Finanzas → Ventas. Además se escribe un archivo JSON con el estado
 * ANTES y DESPUÉS de cada línea: es el respaldo para auditar la corrección y
 * para poder deshacerla si hiciera falta.
 *
 *   Uso:
 *     npx ts-node scripts/repair-retail-frozen-cost.ts \
 *       --product "Mantequillas Mini" --from 1800 --to 0 \
 *       --reason "llegan de regalo por compra mayorista"
 *     ... --apply            (escribe; sin esto es dry-run)
 *     ... --apply --prod     (obligatorio si la base no es local)
 */
import { writeFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';

// ⚠️ `@prisma/client` auto-carga `.env` — el de PRODUCCIÓN — y NO `.env.local`.
// Escribir exige DOS cosas: `--apply` y, si el host no es local, `--prod`.
const APPLY = process.argv.includes('--apply');
const ALLOW_PROD = process.argv.includes('--prod');

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const PRODUCT = argValue('--product');
const FROM = Number(argValue('--from'));
const TO = Number(argValue('--to'));
/** Por qué se corrige. Queda escrito en la nota de cada venta tocada. */
const REASON = argValue('--reason') ?? 'costo mal registrado';

const DB_URL = process.env.DATABASE_URL ?? '';
const DB_HOST =
  DB_URL.replace(/^.*@/, '').replace(/[/?].*$/, '') || '(desconocido)';
const IS_LOCAL = /^(localhost|127\.0\.0\.1|host\.docker\.internal)(:|$)/.test(
  DB_HOST,
);

if (!PRODUCT || !Number.isFinite(FROM) || !Number.isFinite(TO)) {
  console.error(
    '\n✗ Faltan argumentos.\n' +
      '  npx ts-node scripts/repair-retail-frozen-cost.ts --product "Mantequillas Mini" --from 1800 --to 0\n',
  );
  process.exit(1);
}

if (APPLY && !IS_LOCAL && !ALLOW_PROD) {
  console.error(
    `\n✗ Cancelado: ibas a ESCRIBIR en ${DB_HOST}, que no es local.\n` +
      `  Añade --prod de forma deliberada si de verdad es producción.\n`,
  );
  process.exit(1);
}

const prisma = new PrismaClient();
const money = (n: number) =>
  new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(n);

async function main() {
  console.log(`\n→ Base: ${DB_HOST}`);
  console.log(`→ Producto: "${PRODUCT}"`);
  console.log(`→ Costo congelado ${money(FROM)} → ${money(TO)}`);
  console.log(APPLY ? '→ Modo: APLICAR\n' : '→ Modo: dry-run (sin --apply)\n');

  // Se busca por NOMBRE congelado en la línea y no por productId: si el
  // producto se renombró después, el nombre de la venta sigue siendo el de
  // entonces. Aun así se exige el match de costo, que es el filtro real.
  const items = await prisma.retailSaleItem.findMany({
    where: { name: PRODUCT, unitCostCOP: FROM },
    select: {
      id: true,
      saleId: true,
      quantity: true,
      unitPriceCOP: true,
      unitCostCOP: true,
      productId: true,
      sale: { select: { code: true, soldAt: true, status: true } },
    },
    orderBy: { id: 'asc' },
  });

  const others = await prisma.retailSaleItem.findMany({
    where: { name: PRODUCT, unitCostCOP: { not: FROM } },
    select: { unitCostCOP: true, sale: { select: { code: true } } },
  });

  if (items.length === 0) {
    console.log('No hay líneas con ese costo congelado. Nada que corregir.\n');
    if (others.length > 0) {
      console.log(
        `Ojo: hay ${others.length} línea(s) de "${PRODUCT}" con otro costo:`,
      );
      for (const row of others.slice(0, 10)) {
        console.log(`  ${row.sale.code} — costo ${money(row.unitCostCOP)}`);
      }
    }
    return;
  }

  let deltaTotal = 0;
  console.log(`Líneas a corregir (${items.length}):`);
  for (const item of items) {
    const delta = (item.unitCostCOP - TO) * item.quantity;
    deltaTotal += delta;
    console.log(
      `  ${item.sale.code} · ${item.sale.soldAt.toISOString().slice(0, 10)} · ` +
        `x${item.quantity} · precio ${money(item.unitPriceCOP)} · ` +
        `costo ${money(item.unitCostCOP)} → ${money(TO)} ` +
        `(utilidad +${money(delta)})${item.sale.status === 'VOIDED' ? ' [ANULADA]' : ''}`,
    );
  }

  if (others.length > 0) {
    console.log(
      `\nSe dejan intactas ${others.length} línea(s) con otro costo congelado ` +
        `(en su momento ese costo pudo ser el correcto).`,
    );
  }

  const saleIds = [...new Set(items.map((item) => item.saleId))];
  const productIds = [...new Set(items.map((item) => item.productId))];
  console.log(
    `\nResumen: ${items.length} línea(s) en ${saleIds.length} venta(s). ` +
      `La utilidad reportada sube ${money(deltaTotal)}.`,
  );

  if (!APPLY) {
    console.log(
      '\nDry-run: no se escribió nada. Añade --apply para aplicar.\n',
    );
    return;
  }

  // El respaldo se escribe ANTES de tocar nada: si algo falla a mitad, el
  // archivo con el estado previo ya existe.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = `repair-retail-frozen-cost-${stamp}.json`;
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        ejecutadoEn: new Date().toISOString(),
        base: DB_HOST,
        producto: PRODUCT,
        costoAnterior: FROM,
        costoNuevo: TO,
        motivo: REASON,
        utilidadCorregidaCOP: deltaTotal,
        lineas: items.map((item) => ({
          saleItemId: item.id,
          saleId: item.saleId,
          venta: item.sale.code,
          fecha: item.sale.soldAt.toISOString(),
          cantidad: item.quantity,
          precioUnitario: item.unitPriceCOP,
          costoAntes: item.unitCostCOP,
          costoDespues: TO,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\n→ Respaldo escrito en ${reportPath}`);

  const today = new Date().toISOString().slice(0, 10);
  const trace =
    `[${today}] Costo corregido ${money(FROM)} → ${money(TO)} ` +
    `en "${PRODUCT}": ${REASON}`;

  await prisma.$transaction(async (tx) => {
    await tx.retailSaleItem.updateMany({
      where: { id: { in: items.map((item) => item.id) } },
      data: { unitCostCOP: TO },
    });

    // El costo de la venta se RECALCULA desde sus líneas en vez de restarle el
    // delta: así queda consistente aunque la venta tenga otros productos, y
    // aunque se corra el script dos veces.
    for (const saleId of saleIds) {
      const lines = await tx.retailSaleItem.findMany({
        where: { saleId },
        select: { quantity: true, unitCostCOP: true },
      });
      const costCOP = lines.reduce(
        (sum, line) => sum + line.unitCostCOP * line.quantity,
        0,
      );
      // La nota se acumula: si la venta ya tenía una observación, la corrección
      // se suma, no la reemplaza.
      const sale = await tx.retailSale.findUniqueOrThrow({
        where: { id: saleId },
        select: { note: true },
      });
      await tx.retailSale.update({
        where: { id: saleId },
        data: {
          costCOP,
          note: [sale.note, trace].filter(Boolean).join(' · '),
        },
      });
    }

    // Kardex: los movimientos de salida por venta de esos productos con el
    // costo equivocado. Se acotan por referencia a las ventas tocadas.
    const movements = await tx.retailStockMovement.updateMany({
      where: {
        productId: { in: productIds },
        type: 'SALE',
        unitCostCOP: FROM,
        reference: { in: saleIds },
      },
      data: { unitCostCOP: TO },
    });

    console.log(
      `\n✓ ${items.length} línea(s), ${saleIds.length} venta(s) y ` +
        `${movements.count} movimiento(s) de kardex corregidos.`,
    );
  });

  console.log(
    '\nRevisa Finanzas → Ventas: la utilidad del período debe haber subido ' +
      `${money(deltaTotal)}, y cada venta corregida muestra la nota del ajuste.\n` +
      `Guarda ${reportPath} como respaldo de la corrección.\n`,
  );
}

main()
  .catch((error) => {
    console.error('\n✗ Falló:', error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
