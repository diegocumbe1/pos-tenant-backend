import { UnauthorizedException } from '@nestjs/common';
import {
  SkillRequestSignatureVerifier,
  TimestampVerifier,
} from 'ask-sdk-express-adapter';
import { AssistantService } from '../../assistant/assistant.service';
import {
  addCalendarDaysCO,
  calendarDayCO,
  dayEndCO,
} from '../../common/date.util';
import { PrismaService } from '../../prisma/prisma.service';
import { AlexaAdminService } from './alexa-admin.service';
import { AlexaAuthService } from './alexa-auth.service';
import { AlexaSkillRepository } from './alexa-skill.repository';

describe('AlexaAdminService', () => {
  const today = calendarDayCO(new Date());
  const admin = { id: 'u1', name: 'Diego Cumbe', isPlatformAdmin: true };
  const skill = { id: 'sk', tenantId: null, ttlDays: 7 };
  const overview = {
    tenants: { total: 4, active: 3, suspended: 1 },
    subscriptions: { active: 3, trialing: 1, pastDue: 0, billable: 3 },
    mrrCOP: 450000,
    payments: { month: '2026-11', count: 2, totalCOP: 300000 },
  };
  const account = (name: string, day: string, status = 'ACTIVE') => ({
    status,
    trialEndsAt: status === 'TRIALING' ? dayEndCO(day) : null,
    nextPaymentDueAt: dayEndCO(day),
    currentPeriodEnd: dayEndCO(day),
    graceEndsAt: null,
    tenant: { name },
  });

  let service: AlexaAdminService;
  let auth: { actor: jest.Mock; activate: jest.Mock; logout: jest.Mock };
  let skills: { byApplicationId: jest.Mock };
  let assistant: { platformOverview: jest.Mock; sales: jest.Mock };
  let prisma: {
    tenant: { findMany: jest.Mock; count: jest.Mock };
    subscription: { findMany: jest.Mock };
    subscriptionPayment: { groupBy: jest.Mock };
    billingContact: { findFirst: jest.Mock };
  };

  const send = (
    name?: string,
    slots: Record<string, unknown> = {},
    attributes?: Record<string, unknown>,
  ) =>
    service.handleRequest(
      Buffer.from(
        JSON.stringify({
          version: '1.0',
          context: { System: { application: { applicationId: 'admin' } } },
          ...(attributes && { session: { attributes } }),
          request: {
            type: name ? 'IntentRequest' : 'LaunchRequest',
            timestamp: new Date().toISOString(),
            ...(name && { intent: { name, slots } }),
          },
        }),
      ),
      {},
    );
  const said = (result: { response: { outputSpeech?: unknown } }) =>
    (result.response.outputSpeech as { text: string }).text;

  beforeEach(() => {
    jest
      .spyOn(SkillRequestSignatureVerifier.prototype, 'verify')
      .mockResolvedValue(undefined);
    jest
      .spyOn(TimestampVerifier.prototype, 'verify')
      .mockResolvedValue(undefined);
    auth = {
      actor: jest.fn().mockResolvedValue(admin),
      activate: jest.fn(),
      logout: jest.fn(),
    };
    skills = { byApplicationId: jest.fn().mockResolvedValue(skill) };
    assistant = {
      platformOverview: jest.fn().mockResolvedValue(overview),
      sales: jest.fn().mockResolvedValue({ salesCount: 2, revenueCOP: 84000 }),
    };
    prisma = {
      tenant: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      subscription: { findMany: jest.fn().mockResolvedValue([]) },
      subscriptionPayment: { groupBy: jest.fn().mockResolvedValue([]) },
      billingContact: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    service = new AlexaAdminService(
      skills as unknown as AlexaSkillRepository,
      auth as unknown as AlexaAuthService,
      assistant as unknown as AssistantService,
      prisma as unknown as PrismaService,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  describe('acceso', () => {
    it('rechaza una skill atada a un negocio', async () => {
      skills.byApplicationId.mockResolvedValue({ ...skill, tenantId: 't1' });
      await expect(send()).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('sin sesión pide el código y no consulta nada', async () => {
      auth.actor.mockResolvedValue(null);
      const result = await send('PlatformSummaryIntent');
      expect(said(result)).toContain('código de activación');
      expect(assistant.platformOverview).not.toHaveBeenCalled();
    });

    it('rechaza a quien no es de plataforma aunque tenga sesión', async () => {
      auth.actor.mockResolvedValue({ ...admin, isPlatformAdmin: false });
      const result = await send('FailedPaymentsIntent');
      expect(said(result)).toContain('no está autorizada');
      expect(prisma.subscription.findMany).not.toHaveBeenCalled();
    });
  });

  it('las acciones se remiten a la consola y no cambian nada', async () => {
    const result = await send('AccionConsolaIntent', {
      negocio: { name: 'negocio', value: 'bella chic' },
    });
    expect(said(result)).toContain('desde la consola');
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  it('dice lo cobrado, nunca el MRR', async () => {
    const text = said(await send('PlatformSummaryIntent'));
    expect(text).toContain('300000 pesos');
    expect(text).not.toContain('450000');
  });

  it('separa las monedas y da la cifra exacta', async () => {
    prisma.subscriptionPayment.groupBy.mockResolvedValue([
      { currency: 'COP', _count: 2, _sum: { amount: 1234567 } },
      { currency: 'USD', _count: 1, _sum: { amount: 50 } },
    ]);
    const text = said(await send('RevenueIntent'));
    expect(text).toContain('1234567 pesos en 2 pagos');
    expect(text).toContain('50 dólares en 1 pago');
    expect(text.startsWith('Este mes')).toBe(true);
  });

  it('nombra tres vencimientos, cuenta el resto y deja todos en la tarjeta', async () => {
    const day = addCalendarDaysCO(today, 2);
    prisma.subscription.findMany.mockResolvedValue(
      ['A', 'B', 'C', 'D'].map((name) => account(name, day)),
    );
    const result = await send('ExpiringSubscriptionsIntent');
    expect(said(result)).toContain('vencen 4 cuentas');
    expect(said(result)).toContain('y 1 más');
    expect(result.response.card).toMatchObject({
      content: expect.stringContaining('D,'),
    });
  });

  it('la mora solo cuenta lo que ya venció, con sus días', async () => {
    prisma.subscription.findMany.mockResolvedValue([
      account('Vencida', addCalendarDaysCO(today, -3)),
      account('Al día', addCalendarDaysCO(today, 5)),
    ]);
    const text = said(await send('FailedPaymentsIntent'));
    expect(text).toContain('1 cuenta vencida');
    expect(text).toContain('Vencida, 3 días');
    expect(text).not.toContain('Al día');
  });

  describe('estado de un negocio', () => {
    const bella = {
      id: 't1',
      name: 'Bella Chic ',
      status: 'SUSPENDED',
      plan: 'PRO',
      vertical: { code: 'retail' },
      subscription: null,
    };

    it('entiende "bellachi" y responde con el nombre real', async () => {
      prisma.tenant.findMany.mockResolvedValue([bella]);
      const text = said(
        await send('BusinessStatusIntent', {
          negocio: { name: 'negocio', value: 'bellachi' },
        }),
      );
      expect(text).toContain('Bella Chic está suspendida, plan pro.');
      expect(text).toContain('84000 pesos en 2 ventas');
    });

    it('sin negocio lo pregunta', async () => {
      expect(said(await send('BusinessStatusIntent'))).toBe(
        '¿De cuál negocio?',
      );
      expect(prisma.tenant.findMany).not.toHaveBeenCalled();
    });

    it('el contacto no dice teléfono ni correo', async () => {
      prisma.tenant.findMany.mockResolvedValue([bella]);
      prisma.billingContact.findFirst.mockResolvedValue({
        name: 'Paola Gomez',
        role: 'Dueña',
      });
      await send('BusinessContactIntent', {
        negocio: { name: 'negocio', value: 'bella chic' },
      });
      expect(prisma.billingContact.findFirst.mock.calls[0][0].select).toEqual({
        name: true,
        role: true,
      });
    });
  });

  describe('seguimientos', () => {
    it('"y ayer" repite la consulta anterior con la fecha nueva', async () => {
      const yesterday = addCalendarDaysCO(today, -1);
      const text = said(
        await send(
          'FollowUpIntent',
          { fecha: { name: 'fecha', value: yesterday } },
          { lastIntent: 'RevenueIntent', lastSlots: {} },
        ),
      );
      expect(text).toBe('Ayer no se registraron pagos.');
    });

    it('sin consulta anterior pregunta en vez de adivinar', async () => {
      const text = said(
        await send('FollowUpIntent', {
          fecha: { name: 'fecha', value: today },
        }),
      );
      expect(text).toContain('¿Sobre qué consulta?');
    });

    it('ignora una consulta recordada que no existe', async () => {
      const text = said(
        await send(
          'FollowUpIntent',
          { fecha: { name: 'fecha', value: today } },
          { lastIntent: 'SuspendBusinessIntent' },
        ),
      );
      expect(text).toContain('¿Sobre qué consulta?');
    });
  });

  it('repite exactamente lo último que dijo', async () => {
    const first = await send('FailedPaymentsIntent');
    const again = await send(
      'AMAZON.RepeatIntent',
      {},
      first.sessionAttributes,
    );
    expect(said(again)).toBe(said(first));
  });
});
