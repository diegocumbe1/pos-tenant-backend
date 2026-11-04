import { PrismaService } from '../../prisma/prisma.service';
import {
  AssistantQuotaException,
  AssistantQuotaService,
} from './assistant-quota.service';

function serviceFor(
  tenant: { plan: string; featureOverrides?: Record<string, unknown> | null },
  used: number,
) {
  const count = jest.fn().mockResolvedValue(used);
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue(tenant) },
    assistantQueryLog: { count },
  };
  return {
    service: new AssistantQuotaService(prisma as unknown as PrismaService),
    count,
  };
}

describe('AssistantQuotaService', () => {
  it('Basic no tiene Lynko y no cuenta nada', async () => {
    const { service, count } = serviceFor({ plan: 'BASIC' }, 5);
    await expect(service.usage('t1')).resolves.toMatchObject({
      enabled: false,
      used: 0,
      limit: 0,
    });
    expect(count).not.toHaveBeenCalled();
    await expect(service.assertAvailable('t1')).rejects.toMatchObject({
      reason: 'plan',
    });
  });

  it('Pro tiene 100 al mes y corta en la 100', async () => {
    const { service } = serviceFor({ plan: 'PRO' }, 99);
    await expect(service.assertAvailable('t1')).resolves.toMatchObject({
      used: 99,
      limit: 100,
    });

    const full = serviceFor({ plan: 'PRO' }, 100).service;
    const error = await full.assertAvailable('t1', 'Tienda X').catch((e) => e);
    expect(error).toBeInstanceOf(AssistantQuotaException);
    expect(error).toMatchObject({ reason: 'quota', businessName: 'Tienda X' });
  });

  it('Premium tiene 300', async () => {
    const { service } = serviceFor({ plan: 'PREMIUM' }, 0);
    await expect(service.usage('t1')).resolves.toMatchObject({ limit: 300 });
  });

  it('respeta el override del backoffice, incluido "sin tope"', async () => {
    const custom = serviceFor(
      { plan: 'BASIC', featureOverrides: { aiChat: true, aiChatMonthlyLimit: 20 } },
      3,
    ).service;
    await expect(custom.usage('t1')).resolves.toMatchObject({
      enabled: true,
      limit: 20,
    });

    // Infinity se guarda como null en el JSON del override.
    const unlimited = serviceFor(
      { plan: 'PRO', featureOverrides: { aiChatMonthlyLimit: null } },
      5000,
    ).service;
    await expect(unlimited.assertAvailable('t1')).resolves.toMatchObject({
      limit: null,
    });
  });

  it('cuenta solo consultas del mes que respondieron algo', async () => {
    const { service, count } = serviceFor({ plan: 'PRO' }, 1);
    await service.usage('t1');
    const where = count.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: 't1', resolvedTo: null });
    expect(where.outcome.notIn).toEqual(['DENIED_PERMISSION', 'DENIED_PLAN', 'ERROR']);
    expect(where.at.gte).toBeInstanceOf(Date);
  });
});
