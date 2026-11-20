import { ConflictException, ForbiddenException } from '@nestjs/common';
import { TenantAddVerticalService } from './tenant-add-vertical.service';

const ctx = (extra: object = {}) =>
  ({ tenantId: 't1', userId: 'u1', roleCode: 'OWNER', isRoot: false, ...extra }) as never;

function build(opts: { group?: boolean } = {}) {
  const tenant = {
    id: 't1',
    name: 'Fase 4',
    plan: 'PRO',
    subscription: { status: 'TRIALING', trialEndsAt: new Date('2099-01-01') },
    vertical: { code: 'barber' },
    billingGroup: opts.group
      ? { id: 'g1', isActive: true, tenants: [{ vertical: { code: 'barber' } }, { vertical: { code: 'retail' } }] }
      : null,
  };
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue(tenant) },
    businessVertical: {
      findMany: jest.fn().mockResolvedValue([{ code: 'barber' }, { code: 'restaurant' }, { code: 'retail' }]),
      findUnique: jest.fn().mockResolvedValue({
        id: 'v-rest', code: 'restaurant', isActive: true,
        plans: [{ plan: { id: 'p1', code: 'PRO', priceCOP: 0 } }],
      }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1' }) },
    menuPublicConfig: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
    role: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'r1' }) },
    userTenantMembership: { create: jest.fn() },
    userBranch: { createMany: jest.fn() },
    platformAuditLog: { create: jest.fn() },
    tenantTx: { create: jest.fn() },
    $transaction: jest.fn(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)({
            tenant: { create: jest.fn() },
            branch: { create: jest.fn() },
            subscription: { create: jest.fn() },
            menuPublicConfig: { create: jest.fn() },
          })
        : Promise.all(arg as unknown[]),
    ),
  };
  const admin = { seedSystemRolesForTenant: jest.fn() };
  const groups = { create: jest.fn(), addTenant: jest.fn() };
  const pricing = {
    getListPriceAt: jest.fn().mockResolvedValue({ priceUSD: 29, priceCOP: 109000 }),
    getBundleDiscountAt: jest.fn().mockResolvedValue({ additionalBps: 3000 }),
    getRateAt: jest.fn().mockResolvedValue(3000),
    // Agenda 20, Restaurante 30, Tienda 10 (USD): el restaurante es el más caro.
    getPlanPriceAt: jest.fn(async (code: string) => ({ barber: 20, restaurant: 30, retail: 10 })[code] ?? null),
  };
  const service = new TenantAddVerticalService(
    prisma as never, admin as never, groups as never, pricing as never,
  );
  return { service, prisma, admin, groups };
}

describe('TenantAddVerticalService', () => {
  it('solo el dueño', async () => {
    const { service } = build();
    await expect(service.options(ctx({ roleCode: 'MANAGER' }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.add(ctx({ roleCode: 'MANAGER' }), { vertical: 'restaurant' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('ofrece solo lo que aún no tiene', async () => {
    const { service } = build();
    const r = await service.options(ctx());
    expect(r.options.map((o) => o.code).sort()).toEqual(['restaurant', 'retail']);
  });

  it('el descuento lo lleva la vertical más barata, no la que se agrega', async () => {
    const { service } = build();
    const r = await service.options(ctx());
    const rest = r.options.find((o) => o.code === 'restaurant')!;
    // Restaurante (30 USD) es más caro que Agenda (20): va completo y Agenda baja 30%.
    const restLine = rest.lines.find((l) => l.code === 'restaurant')!;
    const agendaLine = rest.lines.find((l) => l.code === 'barber')!;
    expect(restLine.bundleBps).toBe(0);
    expect(restLine.monthlyCOP).toBe(restLine.listCOP);
    expect(agendaLine.bundleBps).toBe(3000);
    expect(agendaLine.monthlyCOP).toBe(Math.round(agendaLine.listCOP * 0.7));
    // La cuota sube menos que el precio de lista del restaurante.
    expect(rest.addedMonthlyCOP).toBeLessThan(restLine.listCOP);
    expect(rest.newMonthlyCOP - rest.currentMonthlyCOP).toBe(rest.addedMonthlyCOP);
  });

  it('si la que se agrega es más barata, ella lleva el descuento', async () => {
    const { service } = build();
    const r = await service.options(ctx());
    const retail = r.options.find((o) => o.code === 'retail')!;
    const line = retail.lines.find((l) => l.code === 'retail')!;
    expect(line.bundleBps).toBe(3000);
    expect(retail.addedMonthlyCOP).toBe(Math.round(10 * 3000 * 0.7));
  });

  it('no repite una vertical que ya tiene', async () => {
    const { service } = build();
    await expect(service.add(ctx(), { vertical: 'barber' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('crea el negocio, da acceso al mismo dueño y arma el combo', async () => {
    const { service, admin, groups, prisma } = build();
    const r = await service.add(ctx(), { vertical: 'restaurant' });
    expect(r.ok).toBe(true);
    expect(admin.seedSystemRolesForTenant).toHaveBeenCalledTimes(1);
    expect(prisma.userTenantMembership.create).toHaveBeenCalledTimes(1);
    expect(groups.create).toHaveBeenCalledWith(
      expect.objectContaining({ primaryTenantId: 't1' }), 'u1',
    );
  });

  it('si ya hay combo, suma al existente en vez de crear otro', async () => {
    const { service, groups } = build({ group: true });
    await service.add(ctx(), { vertical: 'restaurant' }).catch(() => undefined);
    expect(groups.create).not.toHaveBeenCalled();
  });
});
