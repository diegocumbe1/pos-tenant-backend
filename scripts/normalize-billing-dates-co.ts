/**
 * Normaliza a hora Colombia las fechas-calendario de facturación que quedaron
 * guardadas a medianoche UTC.
 *
 * Contexto: el formulario del backoffice mandaba `new Date('YYYY-MM-DD' + 'T00:00:00.000Z')`,
 * o sea medianoche UTC = 19:00 del día ANTERIOR en Colombia. Así, un vencimiento
 * escrito como 10/08 quedaba guardado como el 9 a las 19:00, y todo lo que
 * cuenta días en hora local (el contador de la ficha, el texto de los
 * recordatorios) mostraba un día menos.
 *
 * La escritura ya está corregida (dayStartCO / dayEndCO); este script arregla
 * las filas viejas. Solo toca instantes que caen EXACTAMENTE en medianoche UTC:
 * esos son inequívocamente fruto del bug, porque nadie los escribió a mano.
 *
 *   Fechas de inicio  → 00:00:00.000 de ese día en Colombia
 *   Fechas de fin     → 23:59:59.999 de ese mismo día en Colombia
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/normalize-billing-dates-co.ts          (simulación)
 *   npx ts-node --transpile-only scripts/normalize-billing-dates-co.ts --apply  (aplica)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** ¿El instante cae exactamente en medianoche UTC? Marca del bug. */
const isUtcMidnight = (d: Date | null): d is Date =>
  !!d && d.toISOString().endsWith('T00:00:00.000Z');

/** Día calendario UTC del instante: el que el admin realmente escribió. */
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

const startOfDayCO = (d: Date) => new Date(`${utcDay(d)}T00:00:00.000-05:00`);
const endOfDayCO = (d: Date) => new Date(`${utcDay(d)}T23:59:59.999-05:00`);

type Change = {
  table: string;
  id: string;
  field: string;
  from: string;
  to: string;
};
const changes: Change[] = [];

function plan(
  table: string,
  id: string,
  field: string,
  value: Date | null,
  kind: 'start' | 'end',
): Date | undefined {
  if (!isUtcMidnight(value)) return undefined;
  const next = kind === 'start' ? startOfDayCO(value) : endOfDayCO(value);
  changes.push({
    table,
    id,
    field,
    from: value.toISOString(),
    to: next.toISOString(),
  });
  return next;
}

async function main() {
  const subs = await prisma.subscription.findMany();
  for (const s of subs) {
    const data: Record<string, Date> = {};
    const start = plan(
      'subscription',
      s.tenantId,
      'currentPeriodStart',
      s.currentPeriodStart,
      'start',
    );
    if (start) data.currentPeriodStart = start;
    const end = plan(
      'subscription',
      s.tenantId,
      'currentPeriodEnd',
      s.currentPeriodEnd,
      'end',
    );
    if (end) data.currentPeriodEnd = end;
    const due = plan(
      'subscription',
      s.tenantId,
      'nextPaymentDueAt',
      s.nextPaymentDueAt,
      'end',
    );
    if (due) data.nextPaymentDueAt = due;
    const grace = plan(
      'subscription',
      s.tenantId,
      'graceEndsAt',
      s.graceEndsAt,
      'end',
    );
    if (grace) data.graceEndsAt = grace;
    const trial = plan(
      'subscription',
      s.tenantId,
      'trialEndsAt',
      s.trialEndsAt,
      'end',
    );
    if (trial) data.trialEndsAt = trial;

    if (APPLY && Object.keys(data).length > 0) {
      await prisma.subscription.update({ where: { id: s.id }, data });
    }
  }

  const payments = await prisma.subscriptionPayment.findMany();
  for (const p of payments) {
    const data: Record<string, Date> = {};
    const ps = plan('payment', p.id, 'periodStart', p.periodStart, 'start');
    if (ps) data.periodStart = ps;
    const pe = plan('payment', p.id, 'periodEnd', p.periodEnd, 'end');
    if (pe) data.periodEnd = pe;

    if (APPLY && Object.keys(data).length > 0) {
      await prisma.subscriptionPayment.update({ where: { id: p.id }, data });
    }
  }

  if (changes.length === 0) {
    console.log('No hay fechas a medianoche UTC: nada que normalizar.');
  } else {
    console.log(
      `${changes.length} campo(s) ${APPLY ? 'actualizados' : 'a actualizar'}:\n`,
    );
    for (const c of changes) {
      console.log(`  ${c.table}[${c.id}].${c.field}`);
      console.log(`     ${c.from}  →  ${c.to}`);
    }
    if (!APPLY) console.log('\nSimulación. Corre con --apply para aplicar.');
  }

  await prisma.$disconnect();
}

void main();
