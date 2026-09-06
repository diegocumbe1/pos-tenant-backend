/**
 * Deja un envío con su flete en la factura correcta y el saldo a favor del
 * cliente registrado como abono.
 *
 * EL CASO
 * -------
 * El cliente paga de MÁS una factura, ese excedente le queda a favor, y se
 * aplica contra el siguiente pedido —normalmente contra el flete, porque el
 * paquete se arma después—. Retail no tiene "saldo a favor": los ingresos solo
 * existen como abonos de una venta. Así que el excedente no tenía dónde vivir y
 * se perdía.
 *
 * Caso real (tenant Bella C., EN-000001):
 *
 *   RS-000007  20 ago   productos  247.500  ·  Montero giró  275.000
 *                                               saldo a favor  27.500
 *   RS-000024   5 sept  productos  328.500
 *                     + flete       35.900
 *                     − saldo       27.500
 *                     = giró       336.900
 *
 * Total girado 611.900 = 576.000 de mercancía + 35.900 de guía.  ✓
 *
 * Lo que estaba mal: la 07 decía 247.500 (los otros 27.500 no se apuntaron en
 * ningún lado), la 24 llevaba solo 8.400 de flete en vez de los 35.900 que se
 * le facturaron, y el envío reportaba flete sin cobrar para siempre.
 *
 * EL ESTADO FINAL QUE DEJA
 * ------------------------
 *   · La venta del flete lleva `shippingCOP` = el flete COMPLETO del envío, y
 *     su total sube a `subtotal − descuento + flete`.
 *   · Esa venta recibe un abono por el saldo a favor, CON LA FECHA EN QUE EL
 *     CLIENTE GIRÓ. Eso es lo que pone la plata en el mes correcto: entró en
 *     agosto, no en septiembre.
 *   · Las demás ventas del paquete quedan sin flete (por si alguna lo tenía
 *     mal puesto), con su total de solo mercancía.
 *   · `shippingPrepaidCOP` del envío vuelve a 0 y el gasto de la guía vuelve a
 *     su valor completo: ya no hay nada que netear.
 *
 * POR QUÉ ES LEGÍTIMO
 * -------------------
 * No inventa plata: la suma de los abonos de cada venta tiene que dar su total,
 * y el script ABORTA si no cuadra. Lo único que hace es poner cada peso que el
 * cliente giró en la factura y la fecha que le corresponden.
 *
 * IDEMPOTENTE. Reejecutarlo no duplica el abono ni los eventos.
 *
 * NO toca mercancía, cantidades, stock, costos, fechas de venta ni entregas.
 *
 *   Uso:
 *     npx ts-node scripts/repair-retail-shipment-freight-and-credit.ts \
 *       --shipment EN-000001 --freight-on RS-000024 \
 *       --credit 27500 --credit-date 2026-08-20 --credit-method TRANSFER \
 *       --credit-note "Saldo a favor del giro de 275.000 del 20 de agosto (RS-000007)"
 *     ... --apply            (escribe; sin esto es dry-run)
 *     ... --apply --prod     (obligatorio si la base no es local)
 */
import { writeFileSync } from 'fs';
import { PrismaClient, RetailPaymentMethod } from '@prisma/client';

// ⚠️ `@prisma/client` auto-carga `.env` — el de PRODUCCIÓN — y NO `.env.local`.
// Escribir exige DOS cosas: `--apply` y, si el host no es local, `--prod`.
const APPLY = process.argv.includes('--apply');
const ALLOW_PROD = process.argv.includes('--prod');

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const SHIPMENT = argValue('--shipment');
const FREIGHT_ON = argValue('--freight-on');
const CREDIT = Number(argValue('--credit') ?? 0);
const CREDIT_DATE = argValue('--credit-date');
const CREDIT_METHOD = (argValue('--credit-method') ??
  'TRANSFER') as RetailPaymentMethod;
const CREDIT_NOTE =
  argValue('--credit-note') ?? 'Saldo a favor de un giro anterior del cliente';

/** Marca en el `detail` del evento y en la nota, para no duplicar al reejecutar. */
const MARKER = 'repair-retail-shipment-freight-and-credit';

const DB_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const DB_HOST =
  DB_URL.replace(/^.*@/, '').replace(/[/?].*$/, '') || '(desconocido)';
const IS_LOCAL = /^(localhost|127\.0\.0\.1|host\.docker\.internal)(:|$)/.test(
  DB_HOST,
);

if (!SHIPMENT || !FREIGHT_ON) {
  console.error(
    '\n✗ Faltan argumentos.\n' +
      '  npx ts-node scripts/repair-retail-shipment-freight-and-credit.ts \\\n' +
      '    --shipment EN-000001 --freight-on RS-000024 \\\n' +
      '    --credit 27500 --credit-date 2026-08-20\n',
  );
  process.exit(1);
}
if (CREDIT > 0 && !CREDIT_DATE) {
  console.error(
    '\n✗ Un saldo a favor sin fecha pondría la plata en el mes equivocado.\n' +
      '  Añade --credit-date YYYY-MM-DD (el día en que el cliente giró).\n',
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

const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
const money = (n: number) =>
  '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(n);

async function main() {
  console.log(`\n→ Base: ${DB_HOST}`);
  console.log(`→ Envío: ${SHIPMENT}  ·  flete completo en ${FREIGHT_ON}`);
  if (CREDIT > 0) {
    console.log(`→ Saldo a favor: ${money(CREDIT)} con fecha ${CREDIT_DATE}`);
  }
  console.log(APPLY ? '→ Modo: APLICAR\n' : '→ Modo: dry-run (sin --apply)\n');

  const shipment = await prisma.retailShipment.findFirst({
    where: { code: SHIPMENT },
    include: {
      sales: {
        include: {
          sale: {
            include: {
              payments: {
                where: { voidedAt: null },
                orderBy: { paidAt: 'asc' },
              },
            },
          },
        },
      },
    },
  });
  if (!shipment) {
    console.error(`✗ No existe el envío ${SHIPMENT}.\n`);
    process.exit(1);
  }

  console.log(`  Guía cuesta        ${money(shipment.shippingCostCOP)}`);
  console.log(`  Se le cobra        ${money(shipment.shippingChargedCOP)}`);
  console.log(`  Abono suelto hoy   ${money(shipment.shippingPrepaidCOP)}\n`);

  const sales = shipment.sales
    .map((row) => row.sale)
    .filter((sale) => sale.status !== 'VOIDED');
  const freightSale = sales.find((sale) => sale.code === FREIGHT_ON);
  if (!freightSale) {
    console.error(`✗ ${FREIGHT_ON} no está en el envío ${SHIPMENT}.\n`);
    process.exit(1);
  }

  /** ¿El abono del saldo a favor ya está puesto de una corrida anterior? */
  const creditAlreadyThere = freightSale.payments.some(
    (payment) =>
      payment.amountCOP === CREDIT && (payment.note ?? '').includes(MARKER),
  );

  const plan = sales.map((sale) => {
    const isFreightSale = sale.id === freightSale.id;
    const shippingCOP = isFreightSale ? shipment.shippingChargedCOP : 0;
    const totalCOP = sale.subtotalCOP - sale.discountCOP + shippingCOP;
    const livePaid = sale.payments.reduce((sum, p) => sum + p.amountCOP, 0);
    const addsCredit = isFreightSale && CREDIT > 0 && !creditAlreadyThere;
    const paidAfterCredit = livePaid + (addsCredit ? CREDIT : 0);
    return {
      sale,
      isFreightSale,
      shippingCOP,
      totalCOP,
      livePaid,
      addsCredit,
      paidAfterCredit,
      /** Lo que falta o sobra tras aplicar el crédito. 0 = cuadra. */
      gapCOP: totalCOP - paidAfterCredit,
    };
  });

  let blocked = false;
  for (const step of plan) {
    const { sale } = step;
    console.log(
      `  ${sale.code}  flete ${money(sale.shippingCOP)} → ${money(step.shippingCOP)}` +
        `  ·  total ${money(sale.totalCOP)} → ${money(step.totalCOP)}`,
    );
    console.log(
      `             abonos ${money(step.livePaid)}` +
        (step.addsCredit ? ` + saldo a favor ${money(CREDIT)}` : '') +
        ` = ${money(step.paidAfterCredit)}`,
    );

    if (step.gapCOP === 0) continue;

    // Un solo abono vivo se puede ajustar sin ambigüedad: es el mismo giro,
    // digitado por un valor equivocado. Con varios, no hay forma de saber cuál
    // corregir y eso lo tiene que decidir una persona.
    if (sale.payments.length === 1 && !step.addsCredit) {
      console.log(
        `             ↳ ajusta su único abono ${money(sale.payments[0].amountCOP)} → ${money(step.totalCOP)}`,
      );
      continue;
    }
    console.error(
      `             ✗ quedan ${money(step.gapCOP)} sin cuadrar y tiene ` +
        `${sale.payments.length} abonos. Revísala a mano.`,
    );
    blocked = true;
  }

  if (blocked) {
    console.error('\n✗ Abortado sin escribir: hay ventas que no cuadran.\n');
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `/tmp/repair-freight-credit-${SHIPMENT}-${stamp}.json`;
  writeFileSync(
    backupPath,
    JSON.stringify(
      {
        shipmentCode: SHIPMENT,
        shipmentId: shipment.id,
        shippingPrepaidCOPBefore: shipment.shippingPrepaidCOP,
        before: sales.map((sale) => ({
          code: sale.code,
          shippingCOP: sale.shippingCOP,
          totalCOP: sale.totalCOP,
          paidCOP: sale.paidCOP,
          payments: sale.payments.map((p) => ({
            id: p.id,
            amountCOP: p.amountCOP,
            paidAt: p.paidAt,
          })),
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\n  Respaldo: ${backupPath}`);

  if (!APPLY) {
    console.log('\n→ Dry-run: no se escribió nada. Añade --apply.\n');
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const step of plan) {
      const { sale } = step;

      if (step.addsCredit) {
        await tx.retailSalePayment.create({
          data: {
            tenantId: sale.tenantId,
            branchId: sale.branchId,
            saleId: sale.id,
            amountCOP: CREDIT,
            method: CREDIT_METHOD,
            // La fecha del GIRO, no la de hoy: es lo que hace que el ingreso
            // pese en el mes en que la plata entró de verdad.
            paidAt: new Date(`${CREDIT_DATE}T12:00:00-05:00`),
            note: `${CREDIT_NOTE} · ${MARKER}`,
            userName: 'Corrección',
          },
        });
      } else if (step.gapCOP !== 0 && sale.payments.length === 1) {
        await tx.retailSalePayment.update({
          where: { id: sale.payments[0].id },
          data: { amountCOP: step.totalCOP },
        });
      }

      const changed =
        sale.shippingCOP !== step.shippingCOP ||
        sale.totalCOP !== step.totalCOP ||
        step.addsCredit ||
        step.gapCOP !== 0;

      await tx.retailSale.update({
        where: { id: sale.id },
        data: {
          shippingCOP: step.shippingCOP,
          totalCOP: step.totalCOP,
          paidCOP: step.totalCOP,
          paymentStatus: 'PAID',
        },
      });

      if (!changed) continue;
      await tx.retailSaleEvent.create({
        data: {
          tenantId: sale.tenantId,
          branchId: sale.branchId,
          saleId: sale.id,
          kind: 'SHIPPING_CHARGED',
          summary: step.isFreightSale
            ? `Corrección: el envío ${SHIPMENT} le carga ${money(step.shippingCOP)} de flete` +
              (step.addsCredit
                ? `, y se le aplica ${money(CREDIT)} de saldo a favor`
                : '')
            : `Corrección: se le quitó el flete del envío ${SHIPMENT}`,
          note: CREDIT_NOTE,
          detail: {
            shipmentCode: SHIPMENT,
            shippingCOP: step.shippingCOP,
            previousShippingCOP: sale.shippingCOP,
            previousTotalCOP: sale.totalCOP,
            creditAppliedCOP: step.addsCredit ? CREDIT : 0,
            script: MARKER,
          },
        },
      });
    }

    // El flete ya vive dentro de una venta: el abono suelto del envío sobra.
    await tx.retailShipment.update({
      where: { id: shipment.id },
      data: { shippingPrepaidCOP: 0 },
    });

    // Y el gasto de la guía vuelve a su valor completo. Se reescribe acá, con
    // la misma fórmula de `syncShippingExpense`, porque este script habla con
    // Prisma directo y no pasa por el servicio: sin esto el egreso se quedaría
    // neteado contra un abono que ya no existe.
    const expenseId = `shipexp_${shipment.id}`;
    const shipped =
      shipment.status === 'SENT' || shipment.status === 'DELIVERED';
    if (!shipped || shipment.shippingCostCOP <= 0) {
      await tx.expense.deleteMany({ where: { id: expenseId } });
    } else {
      const data = {
        tenantId: shipment.tenantId,
        branchId: shipment.branchId,
        category: 'SALES_SHIPPING',
        concept: [`Flete envío ${shipment.code}`, shipment.carrier]
          .filter(Boolean)
          .join(' · '),
        amountCOP: shipment.shippingCostCOP,
        incurredAt: shipment.sentAt ?? shipment.createdAt,
        note: shipment.trackingCode ? `Guía ${shipment.trackingCode}` : null,
      };
      await tx.expense.upsert({
        where: { id: expenseId },
        create: { id: expenseId, ...data },
        update: data,
      });
    }
  });

  console.log('\n✓ Aplicado.');
  console.log(
    `  Gasto de la guía: ${money(shipment.shippingCostCOP)} (completo, sin netear).\n`,
  );
}

main()
  .catch((error) => {
    console.error('\n✗ Error:', error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
