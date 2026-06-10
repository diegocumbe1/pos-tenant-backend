import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * Crea una suscripción ACTIVE/manual para cada tenant que no tenga una.
 * Idempotente y NO destructivo (no toca tenants ni usuarios; no inyecta data demo).
 *
 * Uso:
 *   npx ts-node scripts/backfill-subscriptions.ts
 */

const PLAN_PRICE_COP: Record<string, number> = {
  BASIC: 79000,
  PRO: 129000,
  PREMIUM: 219000,
};
const PLAN_PRICE_USD: Record<string, number> = {
  BASIC: 20,
  PRO: 32,
  PREMIUM: 55,
};

async function main() {
  const prisma = new PrismaClient();
  try {
    const tenants = await prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, plan: true },
    });

    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);

    let created = 0;
    for (const t of tenants) {
      const existing = await prisma.subscription.findUnique({
        where: { tenantId: t.id },
      });
      if (existing) continue;
      await prisma.subscription.create({
        data: {
          tenantId: t.id,
          plan: t.plan,
          status: 'ACTIVE',
          billingCycle: 'monthly',
          currentPeriodStart: now,
          currentPeriodEnd: end,
          priceCOP: PLAN_PRICE_COP[t.plan] ?? null,
          priceUSD: PLAN_PRICE_USD[t.plan] ?? null,
          provider: 'manual',
        },
      });
      created += 1;
      console.log(`  + subscription for ${t.name} (${t.id}, ${t.plan})`);
    }
    console.log(
      `✅ Backfill done: ${created} created, ${tenants.length - created} ya tenían.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('❌ Backfill failed:', e);
  process.exit(1);
});
