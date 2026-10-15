/**
 * Alinea el precio de las suscripciones con la tarifa de su vertical.
 *
 * EL DAÑO
 * -------
 * El signup copiaba `Plan.priceCOP` a la suscripción. Ese catálogo es UNO solo
 * para todos los verticales (BASIC/PRO/PREMIUM = 79/129/199 mil), no lo que se
 * configura en /admin/pricing por vertical. Caso real: un retail Premium nació
 * en 199.000 cuando su tarifa es US$35 ≈ 115.500. Como la suscripción no tenía
 * `listPriceCOP`, el backoffice mostraba ese 199.000 como "precio oficial" y
 * los cobros lo tomaban como referencia.
 *
 * QUÉ TOCA
 * --------
 * Solo suscripciones con `listPriceCOP` NULL — nunca las fijó un admin. A esas:
 *   - `listPriceCOP/USD`  ← tarifa vigente del vertical+plan (tasa de hoy).
 *   - `agreedPriceCOP/USD`, `priceCOP/USD` ← lo mismo, SOLO si no hay
 *     `agreedPriceCOP` (nadie pactó nada). Si hay pactado se reporta y se deja.
 *
 * Las que ya tienen `listPriceCOP` las decidió alguien desde el backoffice: se
 * listan si difieren de la tarifa, pero no se tocan. Tampoco se tocan pagos ya
 * registrados.
 *
 * TRAZABILIDAD
 * ------------
 * Cada cambio deja un `platform_audit_logs` (action `subscription.reprice`) con
 * antes/después, y se escribe un JSON con el respaldo completo.
 *
 * DESCUENTOS MAL REGISTRADOS
 * --------------------------
 * Si a un cliente se le dio un precio especial escribiéndolo como "precio
 * oficial" (lista = pactado = precio especial), el sistema no ve descuento.
 * `--relist <tenantId>` pone la lista en la tarifa y CONSERVA el pactado, así
 * el descuento queda a la vista. Repetible para varios tenants.
 *
 *   Uso:
 *     npx ts-node scripts/repair-subscription-list-prices.ts --local    (réplica local, dry-run)
 *     npx ts-node scripts/repair-subscription-list-prices.ts            (PRODUCCIÓN, dry-run)
 *     ... --relist tenant-fab841ba [--reason "precio fundador"]
 *     ... --apply            (escribe)
 *     ... --apply --prod     (obligatorio si la base no es local)
 */
import { config as loadEnv } from 'dotenv';
import { writeFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import {
  DEFAULT_USD_TO_COP_RATE,
  usdToCop,
} from '../src/platform/pricing/plan-pricing.service';

// ⚠️ `@prisma/client` auto-carga `.env` — el de PRODUCCIÓN — y NO `.env.local`.
// `--local` carga `.env.local` (la réplica que usa `start:dev`) por encima.
// Escribir exige DOS cosas: `--apply` y, si el host no es local, `--prod`.
if (process.argv.includes('--local')) {
  loadEnv({ path: '.env.local', override: true });
}
const APPLY = process.argv.includes('--apply');
const ALLOW_PROD = process.argv.includes('--prod');

function argValues(flag: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === flag && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}
const RELIST = new Set(argValues('--relist'));
const REASON = argValues('--reason')[0];

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

const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
const fmt = (n: number | null | undefined) =>
  n == null ? '—' : `$${n.toLocaleString('es-CO')}`;

async function main() {
  const now = new Date();
  const [subs, prices, rateRow] = await Promise.all([
    prisma.subscription.findMany({
      where: { tenant: { deletedAt: null } },
      include: {
        tenant: {
          select: { name: true, vertical: { select: { code: true } } },
        },
      },
    }),
    prisma.planPrice.findMany({
      where: { effectiveFrom: { lte: now } },
      orderBy: { effectiveFrom: 'asc' },
    }),
    prisma.platformRate.findFirst({
      where: { effectiveFrom: { lte: now } },
      orderBy: { effectiveFrom: 'desc' },
    }),
  ]);
  const rate = rateRow?.usdToCopRate ?? DEFAULT_USD_TO_COP_RATE;

  // Ascendente: la última por vertical+plan es la vigente.
  const current = new Map<string, number>();
  for (const p of prices) current.set(`${p.verticalCode}:${p.planCode}`, p.priceUSD);

  console.log(
    `\nBase: ${DB_HOST} · tasa ${rate} · ${subs.length} suscripciones · ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`,
  );

  const backup: unknown[] = [];
  let fixed = 0;

  for (const sub of subs) {
    const vertical = sub.tenant.vertical?.code;
    const label = `${sub.tenant.name} (${sub.tenantId}) · ${vertical ?? 'sin vertical'} ${sub.plan}`;
    const priceUSD = vertical ? current.get(`${vertical}:${sub.plan}`) : undefined;
    if (priceUSD == null) {
      console.log(`  ·  ${label}: sin tarifa cargada, se omite`);
      continue;
    }
    const priceCOP = usdToCop(priceUSD, rate);

    const relist = RELIST.has(sub.tenantId);
    if (sub.listPriceCOP != null && !relist) {
      if (sub.listPriceCOP === priceCOP) {
        console.log(`  ✓  ${label}: ${fmt(sub.listPriceCOP)} ya coincide con la tarifa`);
      } else {
        console.log(
          `  ⚠  ${label}: lista fijada por admin ${fmt(sub.listPriceCOP)} ≠ tarifa ${fmt(priceCOP)}` +
            ` (pactado ${fmt(sub.agreedPriceCOP ?? sub.priceCOP)}) — no se toca; si es un descuento usa --relist ${sub.tenantId}`,
        );
      }
      continue;
    }

    // En --relist lo pactado es lo que hoy paga (agreed, o el legacy priceCOP).
    const currentAgreedCOP = sub.agreedPriceCOP ?? sub.priceCOP;
    if (relist && currentAgreedCOP != null && currentAgreedCOP > priceCOP) {
      console.log(
        `  ✗  ${label}: --relist omitido, paga ${fmt(currentAgreedCOP)} > tarifa ${fmt(priceCOP)}`,
      );
      continue;
    }

    const keepAgreed = relist || sub.agreedPriceCOP != null;
    const data = {
      listPriceCOP: priceCOP,
      listPriceUSD: priceUSD,
      ...(keepAgreed
        ? relist
          ? {
              // Congela explícitamente lo que paga hoy como pactado.
              agreedPriceCOP: currentAgreedCOP ?? undefined,
              priceCOP: currentAgreedCOP ?? undefined,
              ...(REASON || !sub.discountReason
                ? { discountReason: REASON ?? 'precio especial (ajuste de lista)' }
                : {}),
            }
          : {}
        : {
            agreedPriceCOP: priceCOP,
            agreedPriceUSD: priceUSD,
            priceCOP,
            priceUSD,
          }),
    };
    const before = {
      priceCOP: sub.priceCOP,
      priceUSD: sub.priceUSD,
      listPriceCOP: sub.listPriceCOP,
      listPriceUSD: sub.listPriceUSD,
      agreedPriceCOP: sub.agreedPriceCOP,
      agreedPriceUSD: sub.agreedPriceUSD,
      discountReason: sub.discountReason,
    };

    console.log(
      `  ✎  ${label}: ${fmt(sub.listPriceCOP ?? sub.priceCOP)} → lista ${fmt(priceCOP)} (US$${priceUSD})` +
        (keepAgreed
          ? ` · pactado ${fmt(currentAgreedCOP)} se conserva` +
            (relist && currentAgreedCOP != null
              ? ` (descuento ${fmt(priceCOP - currentAgreedCOP)})`
              : '')
          : ''),
    );
    backup.push({ subscriptionId: sub.id, tenantId: sub.tenantId, before, after: data });
    fixed++;

    if (APPLY) {
      await prisma.$transaction([
        prisma.subscription.update({ where: { id: sub.id }, data }),
        prisma.platformAuditLog.create({
          data: {
            actorUserId: 'script:repair-subscription-list-prices',
            action: 'subscription.reprice',
            targetType: 'subscription',
            targetId: sub.tenantId,
            before,
            after: { ...before, ...data, rate },
          },
        }),
      ]);
    }
  }

  if (backup.length) {
    const file = `repair-subscription-list-prices-${now.toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(file, JSON.stringify({ host: DB_HOST, rate, applied: APPLY, rows: backup }, null, 2));
    console.log(`\nRespaldo: ${file}`);
  }
  console.log(
    `\n${fixed} suscripción(es) ${APPLY ? 'corregidas' : 'por corregir (corre con --apply)'}.\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
