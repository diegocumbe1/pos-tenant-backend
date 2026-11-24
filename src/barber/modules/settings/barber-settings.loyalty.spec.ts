import { ForbiddenException } from '@nestjs/common';
import { BarberSettingsService } from './barber-settings.service';

const ctx = { tenantId: 't1', branchId: 'b1' } as never;

function build(tenant: { plan: string; featureOverrides: unknown }) {
  const settings = { loyaltyEnabled: false, loyaltyRules: [] as unknown };
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue(tenant) },
    barberSettings: {
      update: jest.fn().mockImplementation(({ data }) => {
        Object.assign(settings, data);
        return Promise.resolve(settings);
      }),
    },
  };
  const service = new BarberSettingsService(prisma as never, {} as never);
  // `ensureSettings` toca la base: aquí solo importa la lealtad.
  jest
    .spyOn(service as never, 'ensureSettings' as never)
    .mockResolvedValue(settings as never);
  return { service, prisma };
}

describe('lealtad guardada en el servidor', () => {
  const dto = {
    enabled: true,
    rules: [{ everyNVisits: 6, discountPercent: 100, label: ' Sesión #6 gratis ' }],
  };

  it('rechaza guardar si el plan no la incluye', async () => {
    const { service, prisma } = build({ plan: 'PRO', featureOverrides: null });
    await expect(service.saveLoyalty(ctx, dto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.barberSettings.update).not.toHaveBeenCalled();
  });

  it('permite guardar si el super-admin la habilitó', async () => {
    const { service } = build({
      plan: 'PRO',
      featureOverrides: { loyaltyProgram: true },
    });
    const saved = await service.saveLoyalty(ctx, dto);
    expect(saved.rules).toHaveLength(1);
    expect(saved.rules[0].label).toBe('Sesión #6 gratis');
    expect(saved.rules[0].id).toMatch(/^rule-/);
  });

  it('vencida la activación por días, vuelve a rechazar', async () => {
    const { service } = build({
      plan: 'PRO',
      featureOverrides: { loyaltyProgram: true, loyaltyProgramUntil: Date.now() - 1 },
    });
    await expect(service.saveLoyalty(ctx, dto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('leer informa si está permitida y devuelve las reglas', async () => {
    const { service } = build({ plan: 'PRO', featureOverrides: null });
    const loyalty = await service.getLoyalty(ctx);
    expect(loyalty).toEqual({ allowed: false, enabled: false, rules: [] });
  });
});
