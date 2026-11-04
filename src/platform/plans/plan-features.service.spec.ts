import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  resolveEffectiveFeatures,
  resolveFeatureValue,
  setDisabledAssistantVerticals,
  setEditedPlanDefaults,
} from './plan-features';
import { PlanFeaturesService } from './plan-features.service';

function serviceWith(stored: unknown) {
  let saved: unknown = stored;
  let verticals: unknown = null;
  const prisma = {
    platformPricingConfig: {
      findUnique: jest.fn(async () => ({ planFeatureDefaults: saved, assistantVerticals: verticals })),
      upsert: jest.fn(async ({ update }: { update: { planFeatureDefaults?: unknown; assistantVerticals?: unknown } }) => {
        if ('planFeatureDefaults' in update) saved = update.planFeatureDefaults;
        if ('assistantVerticals' in update) verticals = update.assistantVerticals;
      }),
    },
  };
  return {
    service: new PlanFeaturesService(prisma as unknown as PrismaService),
    prisma,
    saved: () => saved,
  };
}

describe('PlanFeaturesService', () => {
  afterEach(() => {
    setEditedPlanDefaults({});
    setDisabledAssistantVerticals([]);
  });

  it('de fábrica Lynko solo está encendido en retail', async () => {
    const { service } = serviceWith(null);
    await service.reload();
    expect(service.publicPlans().assistantVerticals).toEqual({
      retail: true,
      restaurant: false,
      barber: false,
    });
    expect(resolveEffectiveFeatures('PREMIUM', null, 'restaurant').aiChat).toBe(false);
    expect(resolveEffectiveFeatures('PREMIUM', null, 'retail').aiChat).toBe(true);
  });

  it('lo editado pisa la fábrica y el override del tenant pisa lo editado', async () => {
    const { service } = serviceWith({ PRO: { aiChatMonthlyLimit: 150 } });
    await service.reload();
    expect(resolveFeatureValue('PRO', 'aiChatMonthlyLimit')).toBe(150);
    expect(resolveFeatureValue('PREMIUM', 'aiChatMonthlyLimit')).toBe(300);
    expect(
      resolveEffectiveFeatures('PRO', { aiChatMonthlyLimit: 20 }).aiChatMonthlyLimit,
    ).toBe(20);
  });

  it('guarda solo lo que difiere de fábrica y null = sin tope', async () => {
    const { service, saved } = serviceWith(null);
    await service.update('PRO', { aiChatMonthlyLimit: 120, aiChat: true }, 'admin');
    expect(saved()).toEqual({ PRO: { aiChatMonthlyLimit: 120 } });

    await service.update('premium', { aiChatMonthlyLimit: null }, 'admin');
    expect(resolveFeatureValue('PREMIUM', 'aiChatMonthlyLimit')).toBe(Infinity);
    const view = await service.view();
    expect(view.plans.PREMIUM.aiChatMonthlyLimit).toBeNull();
    expect(view.edited.PREMIUM).toEqual(['aiChatMonthlyLimit']);
  });

  it('volver al valor de fábrica limpia la edición', async () => {
    const { service, saved } = serviceWith({ PRO: { aiChatMonthlyLimit: 150 } });
    await service.update('PRO', { aiChatMonthlyLimit: 100 }, 'admin');
    expect(saved()).toEqual({});
    expect(resolveFeatureValue('PRO', 'aiChatMonthlyLimit')).toBe(100);
  });

  it('rechaza claves, tipos y planes inválidos', async () => {
    const { service } = serviceWith(null);
    await expect(service.update('PRO', { inventado: 1 }, 'a')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('PRO', { aiChat: 1 }, 'a')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('PRO', { aiChatMonthlyLimit: -5 }, 'a')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('PRO', { aiChatMonthlyLimit: 1.5 }, 'a')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('GOLD', { aiChat: true }, 'a')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('apagar una vertical gana sobre plan y override', async () => {
    const { service } = serviceWith(null);
    await service.setAssistantVertical('retail', false, 'admin');
    expect(resolveEffectiveFeatures('PREMIUM', { aiChat: true }, 'retail').aiChat).toBe(false);
    await service.setAssistantVertical('barber', true, 'admin');
    expect(resolveEffectiveFeatures('PREMIUM', null, 'barber').aiChat).toBe(true);
    await service.setAssistantVertical('barber', false, 'admin');
    expect(
      resolveEffectiveFeatures('PREMIUM', { aiChat: true }, 'barber').aiChat,
    ).toBe(false);
    expect(resolveFeatureValue('PREMIUM', 'aiChat', { aiChat: true }, 'barber')).toBe(false);
    // Encenderla no se lo regala a Basic.
    await service.setAssistantVertical('barber', true, 'admin');
    expect(resolveEffectiveFeatures('BASIC', null, 'barber').aiChat).toBe(false);
    await expect(service.setAssistantVertical('otra', true, 'a')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ignora lo guardado que ya no existe o tiene otro tipo', async () => {
    const { service } = serviceWith({ PRO: { viejo: true, aiChat: 'si', maxUsers: 20 } });
    await service.reload();
    expect(resolveFeatureValue('PRO', 'aiChat')).toBe(true);
    expect(resolveFeatureValue('PRO', 'maxUsers')).toBe(20);
  });
});
