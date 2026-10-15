/**
 * Corrige el registro del trato de bienvenida de MALEXCA (tenant-e2593413).
 *
 * LO ACORDADO
 * -----------
 * Tarifa barber Pro vigente al pago: US$25 × 3.300 = $82.500/mes.
 *   Mes 1  (15/09/2026 → 15/10/2026): GRATIS, configuración.
 *   Mes 2-5 (15/10/2026 → 15/02/2027): 4 meses a $41.000 = $164.000 (50%),
 *   pagados por adelantado el 17/09/2026.
 *   Desde el 15/02/2027: tarifa completa, $82.500.
 *
 * EL DAÑO
 * -------
 * Se registró un único pago de $164.000 por 15/09 → 15/02 dejando vacío
 * "Precio de lista": quedó con lista = monto, descuento 0, y el mes gratis
 * mezclado dentro del pago. Finanzas lo ve como 5 meses a tarifa completa
 * sin ningún descuento.
 *
 * QUÉ HACE
 * --------
 *   1. Pago existente: periodo → 15/10/2026 → 15/02/2027, lista $330.000,
 *      descuento $166.000 con motivo. Monto ($164.000) y fecha de caja intactos.
 *   2. Crea un BONO (no suma a ingresos): 15/09 → 15/10/2026, lista $82.500,
 *      monto 0, descuento $82.500, motivo "mes de configuración".
 *   3. Suscripción: vencimiento 15/02/2027 (+5 días de gracia), lista y
 *      pactado en $82.500.
 *
 * Deja `platform_audit_logs` con antes/después y un JSON de respaldo.
 * Idempotente: si ya se aplicó, no hace nada.
 *
 *   npx ts-node scripts/repair-malexca-welcome-payment.ts --local            (dry-run)
 *   npx ts-node scripts/repair-malexca-welcome-payment.ts                    (prod, dry-run)
 *   ... --apply [--prod]
 */
import { config as loadEnv } from 'dotenv';
import { writeFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import { dayEndCO, dayStartCO } from '../src/common/date.util';
import { GRACE_DAYS } from '../src/platform/platform.constants';

if (process.argv.includes('--local')) {
  loadEnv({ path: '.env.local', override: true });
}
const APPLY = process.argv.includes('--apply');
const ALLOW_PROD = process.argv.includes('--prod');

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

const TENANT_ID = 'tenant-e2593413';
const ACTOR = 'script:repair-malexca-welcome-payment';
const MONTHLY_LIST = 82_500;

const AMOUNT = 164_000;
const PAY_OFFICIAL = MONTHLY_LIST * 4; // 330.000
const PAY_DISCOUNT = PAY_OFFICIAL - AMOUNT; // 166.000
const PAY_REASON = 'Bienvenida: 4 meses a $41.000 (50%), pago anticipado';
const PAY_START = dayStartCO('2026-10-15');
// Fin real del trato (1 gratis + 4 pagados). Una versión previa de este script
// lo había recortado al 15/01/2027; aquí se restaura.
const PAY_END = dayEndCO('2027-02-15');
const GRACE_END = new Date(PAY_END.getTime() + GRACE_DAYS * 86_400_000);

const BONUS_START = dayStartCO('2026-09-15');
const BONUS_END = dayEndCO('2026-10-15');
const BONUS_REASON = 'Mes 1 gratis: configuración de la cuenta';

const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

async function main() {
  console.log(`\nBase: ${DB_HOST} · ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

  const payments = await prisma.subscriptionPayment.findMany({
    where: { tenantId: TENANT_ID, kind: 'payment', amount: AMOUNT },
  });
  if (payments.length !== 1) {
    throw new Error(
      `Se esperaba 1 pago de ${AMOUNT} para ${TENANT_ID}, hay ${payments.length}. No se toca nada.`,
    );
  }
  const pay = payments[0];
  const existingBonus = await prisma.subscriptionPayment.findFirst({
    where: { tenantId: TENANT_ID, kind: 'bonus', discountReason: BONUS_REASON },
  });
  const sub = await prisma.subscription.findUniqueOrThrow({
    where: { tenantId: TENANT_ID },
  });

  if (
    pay.officialPrice === PAY_OFFICIAL &&
    pay.discountApplied === PAY_DISCOUNT &&
    pay.periodStart.getTime() === PAY_START.getTime() &&
    pay.periodEnd.getTime() === PAY_END.getTime() &&
    sub.currentPeriodEnd.getTime() === PAY_END.getTime() &&
    existingBonus
  ) {
    console.log('✓ Ya está corregido. Nada que hacer.\n');
    return;
  }

  const payBefore = {
    periodStart: pay.periodStart.toISOString(),
    periodEnd: pay.periodEnd.toISOString(),
    officialPrice: pay.officialPrice,
    discountApplied: pay.discountApplied,
    discountReason: pay.discountReason,
  };
  const payAfter = {
    periodStart: PAY_START.toISOString(),
    periodEnd: PAY_END.toISOString(),
    officialPrice: PAY_OFFICIAL,
    discountApplied: PAY_DISCOUNT,
    discountReason: PAY_REASON,
  };
  const bonus = {
    tenantId: TENANT_ID,
    subscriptionId: pay.subscriptionId ?? sub.id,
    plan: pay.plan,
    kind: 'bonus',
    countsAsRevenue: false,
    amount: 0,
    officialPrice: MONTHLY_LIST,
    discountApplied: MONTHLY_LIST,
    discountReason: BONUS_REASON,
    currency: 'COP',
    billingCycle: pay.billingCycle,
    periodStart: BONUS_START,
    periodEnd: BONUS_END,
    // Misma fecha que el pago: se acordó junto. No suma a caja (es bono).
    paidAt: pay.paidAt,
    method: 'manual',
    note: 'Separado del pago anticipado del 17/09 (corrección)',
    extendsPeriod: false,
    createdByUserId: ACTOR,
  };
  const subBefore = {
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
    nextPaymentDueAt: sub.nextPaymentDueAt?.toISOString() ?? null,
    graceEndsAt: sub.graceEndsAt?.toISOString() ?? null,
    priceCOP: sub.priceCOP,
    listPriceCOP: sub.listPriceCOP,
    agreedPriceCOP: sub.agreedPriceCOP,
  };
  const subAfter = {
    ...subBefore,
    currentPeriodEnd: PAY_END.toISOString(),
    nextPaymentDueAt: PAY_END.toISOString(),
    graceEndsAt: GRACE_END.toISOString(),
    priceCOP: MONTHLY_LIST,
    listPriceCOP: MONTHLY_LIST,
    agreedPriceCOP: MONTHLY_LIST,
  };

  console.log('PAGO   antes:  ', payBefore);
  console.log('       después:', payAfter);
  console.log(
    existingBonus ? 'BONO   ya existe, no se crea' : 'BONO   nuevo:  ',
    existingBonus ? '' : {
      ...bonus,
      periodStart: BONUS_START.toISOString(),
      periodEnd: BONUS_END.toISOString(),
      paidAt: pay.paidAt.toISOString(),
    },
  );
  console.log('SUSCR. antes:  ', subBefore);
  console.log('       después:', subAfter);

  writeFileSync(
    `repair-malexca-welcome-payment-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    JSON.stringify(
      { host: DB_HOST, applied: APPLY, paymentId: pay.id, payBefore, payAfter, bonus, subBefore, subAfter },
      null,
      2,
    ),
  );

  if (!APPLY) {
    console.log('\nDry-run: corre con --apply para escribir.\n');
    return;
  }

  await prisma.$transaction([
    prisma.subscriptionPayment.update({
      where: { id: pay.id },
      data: {
        periodStart: PAY_START,
        periodEnd: PAY_END,
        officialPrice: PAY_OFFICIAL,
        discountApplied: PAY_DISCOUNT,
        discountReason: PAY_REASON,
      },
    }),
    ...(existingBonus ? [] : [prisma.subscriptionPayment.create({ data: bonus })]),
    prisma.subscription.update({
      where: { tenantId: TENANT_ID },
      data: {
        currentPeriodEnd: PAY_END,
        nextPaymentDueAt: PAY_END,
        graceEndsAt: GRACE_END,
        priceCOP: MONTHLY_LIST,
        listPriceCOP: MONTHLY_LIST,
        agreedPriceCOP: MONTHLY_LIST,
      },
    }),
    prisma.platformAuditLog.create({
      data: {
        actorUserId: ACTOR,
        action: 'subscription.payment.correct',
        targetType: 'subscription',
        targetId: TENANT_ID,
        before: { payment: payBefore, subscription: subBefore },
        after: {
          payment: payAfter,
          bonusCreated: !existingBonus,
          subscription: subAfter,
        },
      },
    }),
  ]);
  console.log('\n✓ Corregido.\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
