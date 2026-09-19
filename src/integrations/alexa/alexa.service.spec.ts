import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AlexaSkill } from '@prisma/client';
import {
  SkillRequestSignatureVerifier,
  TimestampVerifier,
} from 'ask-sdk-express-adapter';
import { AssistantScopeService } from '../../assistant/assistant-scope.service';
import { AssistantService } from '../../assistant/assistant.service';
import { PlatformOverviewAnswer } from '../../assistant/assistant.types';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import { formatCOP } from '../../common/date.util';
import { AlexaAuthService } from './alexa-auth.service';
import { AlexaSkillRepository } from './alexa-skill.repository';
import { AlexaService } from './alexa.service';

const overview: PlatformOverviewAnswer = {
  tenants: { total: 4, active: 3, suspended: 1 },
  subscriptions: { active: 3, trialing: 0, pastDue: 0, billable: 3 },
  mrrCOP: 450000,
  payments: { month: '2026-09', count: 2, totalCOP: 300000 },
};

const ASK_FOR_CODE =
  'Para consultar tus negocios necesito tu código de activación. Di: mi código es, y tu frase.';

/** Los textos del documento APL, en el orden en que se pintan. */
const textsOf = (directive: unknown): string[] => {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const item = node as Record<string, unknown>;
    if (item.type === 'Text' && typeof item.text === 'string') {
      found.push(item.text);
    }
    Object.values(item).forEach(walk);
  };
  walk(directive);
  return found;
};

describe('AlexaService', () => {
  let service: AlexaService;
  let auth: {
    actor: jest.Mock;
    activate: jest.Mock;
    logout: jest.Mock;
  };
  let assistant: {
    platformOverview: jest.Mock;
    pendingPayment: jest.Mock;
    inventoryStatus?: jest.Mock;
    sales?: jest.Mock;
    pendingDelivery?: jest.Mock;
    businessReport?: jest.Mock;
  };
  let scope: { resolveBusiness: jest.Mock; accessibleBusinesses: jest.Mock };
  let skills: { byApplicationId: jest.Mock; invalidate: jest.Mock };
  const skill = {
    id: 'sk1',
    applicationId: 'test-skill',
    ttlDays: 7,
  } as unknown as AlexaSkill;
  const bella = { id: 't1', name: 'Bella Chic' };
  let signature: jest.SpyInstance;
  const skillId = 'test-skill';
  const actor = { id: 'user-1', name: 'Diego Cumbe' } as AuthenticatedUser;
  const envelope = (
    type = 'LaunchRequest',
    name?: string,
    slots?: Record<string, { name: string; value: string }>,
  ) => ({
    version: '1.0',
    context: { System: { application: { applicationId: skillId } } },
    request: {
      type,
      timestamp: new Date().toISOString(),
      ...(name && { intent: { name, ...(slots && { slots }) } }),
    },
  });
  const send = (body: unknown) =>
    service.handleRequest(Buffer.from(JSON.stringify(body)), {});
  const activation = (value: string) =>
    send(
      envelope('IntentRequest', 'ActivarLynkoIntent', {
        codigo: { name: 'codigo', value },
      }),
    );
  const build = () => {
    service = new AlexaService(
      skills as unknown as AlexaSkillRepository,
      auth as unknown as AlexaAuthService,
      assistant as unknown as AssistantService,
      scope as unknown as AssistantScopeService,
    );
  };

  it('keeps the business after fallback and validates authorization on the next query', async () => {
    const result = await send({
      ...envelope('IntentRequest', 'AMAZON.FallbackIntent'),
      session: { attributes: { businessId: 't1', unexpected: 'private' } },
    });
    expect(result.sessionAttributes).toEqual({ businessId: 't1' });
    expect(result.response.shouldEndSession).toBe(false);
    expect(JSON.stringify(result.response)).not.toMatch(/código|clave|activar/);
    expect(result.response.reprompt?.outputSpeech).toMatchObject({
      type: 'PlainText',
      text: 'Puedes decir: cuánto vendí hoy, qué se está agotando, o qué tengo por entregar.',
    });
    expect(auth.activate).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
    auth.actor.mockResolvedValue(null);
    const expired = await send(envelope('IntentRequest', 'pending_payment'));
    expect(expired.response.outputSpeech).toMatchObject({
      type: 'PlainText',
      text: ASK_FOR_CODE,
    });
    expect(assistant.pendingPayment).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    auth = {
      actor: jest.fn().mockResolvedValue(actor),
      activate: jest.fn().mockResolvedValue('active'),
      logout: jest.fn().mockResolvedValue(undefined),
    };
    assistant = {
      platformOverview: jest.fn().mockResolvedValue(overview),
      pendingPayment: jest.fn().mockResolvedValue({
        business: bella,
        totalCOP: 180000,
        salesCount: 3,
        customers: [
          { name: 'Marcela Ruiz', amountCOP: 120000, salesCount: 2 },
          { name: 'Iván Pardo', amountCOP: 60000, salesCount: 1 },
        ],
        unidentified: { amountCOP: 0, salesCount: 0 },
      }),
    };
    assistant.inventoryStatus = jest.fn().mockResolvedValue({
      business: bella,
      trackedProducts: 40,
      totalUnits: 320,
      valueAtCostCOP: 4500000,
      valueAtPriceCOP: 7200000,
      lowStock: [
        { name: 'Base líquida', stock: 0, minStock: 3 },
        { name: 'Rímel negro', stock: 2, minStock: 5 },
        { name: 'Labial rojo', stock: 4, minStock: 6 },
        { name: 'Polvo compacto', stock: 5, minStock: 8 },
      ],
      lowStockCount: 4,
      outOfStockCount: 1,
    });
    assistant.sales = jest.fn().mockResolvedValue({
      business: bella,
      period: 'day',
      salesCount: 6,
      revenueCOP: 840000,
      unitsSold: 14,
      averageTicketCOP: 140000,
      marginPct: 38.5,
      creditedCOP: 120000,
    });
    assistant.businessReport = jest.fn().mockResolvedValue({
      business: bella,
      period: 'day',
      sales: {
        salesCount: 6,
        revenueCOP: 840000,
        unitsSold: 14,
        averageTicketCOP: 140000,
        marginPct: 38.5,
        creditedCOP: 120000,
      },
      debt: {
        totalCOP: 1200000,
        salesCount: 12,
        customers: [
          { name: 'Marcela Ruiz', amountCOP: 700000, salesCount: 5 },
          { name: 'Iván Pardo', amountCOP: 500000, salesCount: 7 },
        ],
        unidentified: { amountCOP: 0, salesCount: 0 },
      },
      inventory: {
        trackedProducts: 40,
        totalUnits: 320,
        valueAtCostCOP: 4500000,
        valueAtPriceCOP: 7200000,
        lowStock: [{ name: 'Base líquida', stock: 0, minStock: 3 }],
        lowStockCount: 4,
        outOfStockCount: 1,
      },
      purchases: { openCount: 3, estimatedOpenCostCOP: 900000 },
      delivery: {
        salesCount: 5,
        totalCOP: 400000,
        customers: [{ name: 'Marcela Ruiz', salesCount: 2, totalCOP: 200000 }],
      },
    });
    assistant.pendingDelivery = jest.fn().mockResolvedValue({
      business: bella,
      salesCount: 3,
      totalCOP: 260000,
      customers: [
        { name: 'Marcela Ruiz', salesCount: 2, totalCOP: 200000 },
        { name: 'Iván Pardo', salesCount: 1, totalCOP: 60000 },
      ],
    });
    scope = {
      resolveBusiness: jest
        .fn()
        .mockResolvedValue({ status: 'resolved', business: bella }),
      accessibleBusinesses: jest
        .fn()
        .mockResolvedValue([bella, { id: 't2', name: 'DC Tech' }]),
    };
    skills = {
      byApplicationId: jest.fn().mockResolvedValue(skill),
      invalidate: jest.fn(),
    };
    build();
    signature = jest
      .spyOn(SkillRequestSignatureVerifier.prototype, 'verify')
      .mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [
      'LaunchRequest',
      undefined,
      'Hola Diego. Lynko está listo. Puedes preguntarme por tus suscripciones.',
      false,
    ],
    [
      'IntentRequest',
      'GetSubscriptionsIntent',
      'Tienes 3 suscripciones activas, sobre 4 negocios en total. Este mes has recibido 2 pagos por 300000 pesos.',
      false,
    ],
    [
      'IntentRequest',
      'AMAZON.HelpIntent',
      'Puedes preguntarme cuántas suscripciones tienes, o por un negocio: cuánto vendí hoy, quién me debe, qué tengo por entregar, qué se está acabando, qué está agotado, o cuánto vale mi inventario. Para activar el acceso di: mi código es, y tu frase.',
      false,
    ],
    [
      'IntentRequest',
      'AMAZON.YesIntent',
      'Para el detalle di: quién me debe, qué se está acabando, o qué tengo por entregar.',
      false,
    ],
    [
      'IntentRequest',
      'AMAZON.NoIntent',
      'Listo. Aquí estoy si necesitas algo más.',
      false,
    ],
    // Llega al tocar "inicio" en una pantalla; no puede caer en el fallback.
    [
      'IntentRequest',
      'AMAZON.NavigateHomeIntent',
      'Para el detalle di: quién me debe, qué se está acabando, o qué tengo por entregar.',
      false,
    ],
    ['IntentRequest', 'DespedidaIntent', 'Con gusto. Hasta luego.', true],
    ['IntentRequest', 'AMAZON.StopIntent', 'Hasta luego.', true],
    ['IntentRequest', 'AMAZON.CancelIntent', 'Hasta luego.', true],
    [
      'IntentRequest',
      'AMAZON.FallbackIntent',
      'No entendí esa consulta. Puedes decir: cuánto vendí hoy, qué se está agotando, o qué tengo por entregar.',
      false,
    ],
    [
      'IntentRequest',
      'UnknownIntent',
      'No entendí esa consulta. Puedes decir: cuánto vendí hoy, qué se está agotando, o qué tengo por entregar.',
      false,
    ],
  ])('handles %s %s', async (type, name, text, shouldEndSession) => {
    const result = await send(envelope(type, name));
    expect(result).toMatchObject({
      version: '1.0',
      response: { outputSpeech: { type: 'PlainText', text }, shouldEndSession },
    });
    expect(Boolean(result.response.reprompt)).toBe(!shouldEndSession);
  });

  describe('voice authorization', () => {
    const speech = (result: { response: { outputSpeech?: unknown } }) =>
      (result.response.outputSpeech as { text: string }).text;

    it.each(['LaunchRequest', 'IntentRequest'])(
      'asks for the activation code on %s when the grant expired',
      async (type) => {
        auth.actor.mockResolvedValue(null);
        const result = await send(envelope(type, 'GetSubscriptionsIntent'));
        expect(speech(result)).toBe(ASK_FOR_CODE);
        expect(result.response.shouldEndSession).toBe(false);
      },
    );

    it.each([
      [
        new ForbiddenException(),
        'Esta cuenta de Alexa no está autorizada para usar Lynko.',
      ],
      [
        new ServiceUnavailableException(),
        'La autorización por voz de Lynko todavía no está configurada.',
      ],
    ])(
      'rejects with a spoken reason instead of an error',
      async (error, text) => {
        auth.actor.mockRejectedValue(error);
        const result = await send(envelope());
        expect(speech(result)).toBe(text);
        expect(result.response.shouldEndSession).toBe(true);
      },
    );

    it('grants access for the configured window', async () => {
      const result = await activation('mi frase secreta larga');
      expect(auth.activate).toHaveBeenCalledWith(
        expect.objectContaining({ version: '1.0' }),
        skill,
        'mi frase secreta larga',
      );
      expect(speech(result)).toBe(
        'Listo. Tu acceso a Lynko queda activo 7 días. Puedes preguntarme por tus suscripciones.',
      );
      expect(result.response.shouldEndSession).toBe(false);
    });

    it('keeps the session open after a wrong code', async () => {
      auth.activate.mockResolvedValue('invalid');
      const result = await activation('frase equivocada aqui');
      expect(speech(result)).toBe(
        'Ese código no coincide. Inténtalo otra vez.',
      );
      expect(result.response.shouldEndSession).toBe(false);
    });

    it('ends the session once attempts are exhausted', async () => {
      auth.activate.mockResolvedValue('locked');
      const result = await activation('frase equivocada aqui');
      expect(speech(result)).toBe(
        'Demasiados intentos fallidos. Espera quince minutos antes de volver a intentarlo.',
      );
      expect(result.response.shouldEndSession).toBe(true);
    });

    it('never calls activate without a spoken phrase', async () => {
      const result = await send(
        envelope('IntentRequest', 'ActivarLynkoIntent'),
      );
      expect(auth.activate).not.toHaveBeenCalled();
      expect(speech(result)).toBe(
        'No alcancé a escuchar el código. Di: mi código es, y luego tu frase.',
      );
    });

    it('revokes access on request', async () => {
      const result = await send(
        envelope('IntentRequest', 'CerrarAccesoIntent'),
      );
      expect(auth.logout).toHaveBeenCalled();
      expect(speech(result)).toBe('Listo. Cerré tu acceso a Lynko.');
      expect(result.response.shouldEndSession).toBe(true);
    });

    it('does not reach services before the grant is checked', async () => {
      auth.actor.mockResolvedValue(null);
      await send(envelope('IntentRequest', 'GetSubscriptionsIntent'));
      expect(auth.actor).toHaveBeenCalledTimes(1);
      expect(assistant.platformOverview).not.toHaveBeenCalled();
    });

    it('answers a permission failure with speech, not an error', async () => {
      assistant.platformOverview.mockRejectedValue(new ForbiddenException());
      const result = await send(
        envelope('IntentRequest', 'GetSubscriptionsIntent'),
      );
      expect(speech(result)).toBe(
        'Tu usuario no tiene permiso para esa consulta.',
      );
      expect(result.response.shouldEndSession).toBe(true);
    });
  });

  describe('pending payment', () => {
    const askDebt = async (negocio?: string) => {
      const result = await send(
        envelope(
          'IntentRequest',
          'pending_payment',
          negocio
            ? { negocio: { name: 'negocio', value: negocio } }
            : undefined,
        ),
      );
      return (result.response.outputSpeech as { text: string }).text;
    };

    it('names the two biggest debtors and the total', async () => {
      expect(await askDebt('bella chic')).toBe(
        'En Bella Chic te deben 180000 pesos en 3 ventas. Deben Marcela Ruiz, 120000 pesos y Iván Pardo, 60000 pesos.',
      );
      expect(scope.resolveBusiness).toHaveBeenCalledWith(
        actor,
        'bella chic',
        undefined,
      );
      expect(assistant.pendingPayment).toHaveBeenCalledWith(actor, bella);
    });

    it('counts the remaining debtors instead of listing them', async () => {
      assistant.pendingPayment.mockResolvedValue({
        business: bella,
        totalCOP: 200000,
        salesCount: 4,
        customers: [
          { name: 'Marcela Ruiz', amountCOP: 120000, salesCount: 2 },
          { name: 'Iván Pardo', amountCOP: 60000, salesCount: 1 },
          { name: 'Sofía Gil', amountCOP: 20000, salesCount: 1 },
        ],
        unidentified: { amountCOP: 0, salesCount: 0 },
      });
      expect(await askDebt('bella chic')).toContain('y 1 cliente más.');
    });

    it('separates counter sales with no customer', async () => {
      assistant.pendingPayment.mockResolvedValue({
        business: bella,
        totalCOP: 50000,
        salesCount: 1,
        customers: [],
        unidentified: { amountCOP: 50000, salesCount: 1 },
      });
      expect(await askDebt('bella chic')).toBe(
        'En Bella Chic te deben 50000 pesos en 1 venta. Hay 50000 pesos en ventas de mostrador sin cliente registrado.',
      );
    });

    it('says so plainly when nothing is owed', async () => {
      assistant.pendingPayment.mockResolvedValue({
        business: bella,
        totalCOP: 0,
        salesCount: 0,
        customers: [],
        unidentified: { amountCOP: 0, salesCount: 0 },
      });
      expect(await askDebt('bella chic')).toBe(
        'En Bella Chic no te deben nada. Todas las ventas están cobradas.',
      );
    });

    it('asks which business without reciting the whole list', async () => {
      scope.resolveBusiness.mockResolvedValue({
        status: 'missing',
        available: [bella, { id: 't2', name: 'DC Tech' }],
      });
      const speech = await askDebt();
      expect(speech).toBe('¿De cuál negocio?');
      expect(speech).not.toContain('DC Tech');
      expect(assistant.pendingPayment).not.toHaveBeenCalled();
    });

    it('does not accept a business outside the authorized ones', async () => {
      scope.resolveBusiness.mockResolvedValue({
        status: 'unknown',
        available: [bella],
      });
      expect(await askDebt('ferretería ajena')).toBe(
        'No reconozco ese negocio. Puedes decir: lista mis negocios.',
      );
      expect(assistant.pendingPayment).not.toHaveBeenCalled();
    });

    it('names only the candidates when the name is ambiguous', async () => {
      scope.resolveBusiness.mockResolvedValue({
        status: 'ambiguous',
        matches: [bella, { id: 't3', name: 'Bella Chic Norte' }],
      });
      expect(await askDebt('bella')).toBe(
        '¿Te refieres a Bella Chic o a Bella Chic Norte?',
      );
    });

    it('lists the businesses only when asked for them', async () => {
      const result = await send(envelope('IntentRequest', 'list_businesses'));
      expect((result.response.outputSpeech as { text: string }).text).toBe(
        'Tienes 2 negocios: Bella Chic, DC Tech.',
      );
    });

    it('remembers the business for the next question in the session', async () => {
      const result = await askDebt('bella chic');
      expect(result).toBeDefined();
      const answered = await send(envelope('IntentRequest', 'pending_payment'));
      // Sin repetir el nombre, pero el id recordado se valida igual.
      expect(scope.resolveBusiness).toHaveBeenLastCalledWith(
        actor,
        undefined,
        undefined,
      );
      expect(answered).toBeDefined();
    });

    it('echoes the resolved business so the next turn has it', async () => {
      const result = await send(
        envelope('IntentRequest', 'pending_payment', {
          negocio: { name: 'negocio', value: 'bella chic' },
        }),
      );
      expect(result.sessionAttributes).toEqual({ businessId: 't1' });
    });

    it('uses the business carried in the session when none is said', async () => {
      const body = envelope('IntentRequest', 'pending_payment') as Record<
        string,
        unknown
      >;
      body.session = { attributes: { businessId: 't1' } };
      await send(body);
      expect(scope.resolveBusiness).toHaveBeenCalledWith(
        actor,
        undefined,
        't1',
      );
    });

    it('requires an active grant like any other query', async () => {
      auth.actor.mockResolvedValue(null);
      await askDebt('bella chic');
      expect(scope.resolveBusiness).not.toHaveBeenCalled();
      expect(assistant.pendingPayment).not.toHaveBeenCalled();
    });
  });

  describe('sales and delivery', () => {
    const ask = async (intent: string) => {
      const result = await send(
        envelope('IntentRequest', intent, {
          negocio: { name: 'negocio', value: 'bella chic' },
        }),
      );
      return (result.response.outputSpeech as { text: string }).text;
    };

    it('separates the period credit from the whole receivable', async () => {
      expect(await ask('sales_summary')).toBe(
        'Hoy en Bella Chic llevas 840000 pesos en 6 ventas, con un ticket promedio de 140000 pesos. De eso, 120000 pesos quedaron fiados.',
      );
    });

    it('omits the credit sentence when everything was collected', async () => {
      assistant.sales!.mockResolvedValue({
        business: bella,
        period: 'day',
        salesCount: 2,
        revenueCOP: 100000,
        unitsSold: 3,
        averageTicketCOP: 50000,
        marginPct: 40,
        creditedCOP: 0,
      });
      expect(await ask('sales_summary')).toBe(
        'Hoy en Bella Chic llevas 100000 pesos en 2 ventas, con un ticket promedio de 50000 pesos.',
      );
    });

    it('says the range out loud so a week is not read as a day', async () => {
      assistant.sales!.mockResolvedValue({
        business: bella,
        period: 'week',
        salesCount: 9,
        revenueCOP: 300000,
        unitsSold: 20,
        averageTicketCOP: 33333,
        marginPct: 30,
        creditedCOP: 0,
      });
      expect(await ask('sales_summary')).toContain('En lo que va de la semana');
    });

    it('does not pretend there were sales when there were none', async () => {
      assistant.sales!.mockResolvedValue({
        business: bella,
        period: 'day',
        salesCount: 0,
        revenueCOP: 0,
        unitsSold: 0,
        averageTicketCOP: 0,
        marginPct: 0,
        creditedCOP: 0,
      });
      expect(await ask('sales_summary')).toBe(
        'No hay ventas hoy en Bella Chic.',
      );
    });

    /** Ayer ya cerró: ni "llevas" ni "hay" son las palabras. */
    it('speaks about yesterday in the past', async () => {
      assistant.sales!.mockResolvedValue({
        business: bella,
        period: 'yesterday',
        salesCount: 4,
        revenueCOP: 220000,
        unitsSold: 7,
        averageTicketCOP: 55000,
        marginPct: 35,
        creditedCOP: 0,
      });
      expect(await ask('sales_summary')).toBe(
        'Ayer en Bella Chic vendiste 220000 pesos en 4 ventas, con un ticket promedio de 55000 pesos.',
      );
    });

    it('says there were no sales yesterday, not that there are none', async () => {
      assistant.sales!.mockResolvedValue({
        business: bella,
        period: 'yesterday',
        salesCount: 0,
        revenueCOP: 0,
        unitsSold: 0,
        averageTicketCOP: 0,
        marginPct: 0,
        creditedCOP: 0,
      });
      expect(await ask('sales_summary')).toBe(
        'No hubo ventas ayer en Bella Chic.',
      );
    });

    it('lists who is waiting for a delivery', async () => {
      expect(await ask('pending_delivery')).toBe(
        'En Bella Chic tienes 3 ventas por entregar, por 260000 pesos. Marcela Ruiz, Iván Pardo.',
      );
    });

    it('says so when there is nothing to deliver', async () => {
      assistant.pendingDelivery!.mockResolvedValue({
        business: bella,
        salesCount: 0,
        totalCOP: 0,
        customers: [],
      });
      expect(await ask('pending_delivery')).toBe(
        'En Bella Chic no tienes entregas pendientes.',
      );
    });
  });

  describe('business report', () => {
    const report = async (periodo?: string) =>
      send(
        envelope(
          'IntentRequest',
          'business_report',
          periodo
            ? { periodo: { name: 'periodo', value: periodo } }
            : undefined,
        ),
      );

    it('gives the five blocks as numbers, without names', async () => {
      const speech = (
        (await report()).response.outputSpeech as { text: string }
      ).text;
      expect(speech).toBe(
        'Reporte de Bella Chic. Hoy vendiste 840000 pesos en 6 ventas. Te deben 1200000 pesos en total, de 2 clientes. Hay 4 productos bajos de stock, 1 agotados. Tienes 3 pedidos abiertos con el proveedor. Y 5 ventas por entregar. Para el detalle di: quién me debe, qué se está acabando, o qué tengo por entregar.',
      );
      expect(speech).not.toContain('Marcela');
    });

    it('puts the names on the card, which is what a screen is for', async () => {
      const card = (await report()).response.card as {
        title: string;
        content: string;
      };
      expect(card.title).toBe('Reporte · Bella Chic');
      expect(card.content).toContain('Marcela Ruiz: 700000');
      expect(card.content).toContain('Base líquida: 0');
    });

    it('keeps the session open to ask for a detail', async () => {
      expect((await report()).response.shouldEndSession).toBe(false);
    });

    /** Una Echo Show declara APL; un Dot no. La respuesta no puede ser igual. */
    const onScreen = () =>
      send({
        ...envelope('IntentRequest', 'business_report'),
        context: {
          System: {
            application: { applicationId: skillId },
            device: {
              supportedInterfaces: { 'Alexa.Presentation.APL': {} },
            },
          },
        },
      });

    it('renders the report on a device with a screen', async () => {
      const response = (await onScreen()).response;
      const directive = response.directives?.[0] as unknown as {
        type: string;
      };
      expect(directive.type).toBe('Alexa.Presentation.APL.RenderDocument');

      expect(textsOf(directive)).toEqual([
        'Bella Chic',
        'Hoy',
        // Una cifra manda: en 5" no caben cuatro del mismo tamaño.
        'VENTAS',
        formatCOP(840000),
        '6 ventas · Margen 38.5%',
        'Por cobrar',
        formatCOP(1200000),
        'Stock bajo',
        '4 · 1 agotados',
        'Por entregar',
        formatCOP(400000),
        'Ticket promedio',
        formatCOP(140000),
      ]);
      // La tarjeta no se reemplaza: es lo que queda en el historial.
      expect(response.card).toBeDefined();
    });

    /**
     * El documento se arma con los valores adentro.
     *
     * Un `${payload.hero}` que no resuelve no falla: el dispositivo pinta el
     * fondo y deja el texto vacío. Esa pantalla negra costó cuatro pruebas en
     * el Echo Show, así que acá no entra ni un binding ni un `@recurso`.
     */
    it('carries no bindings or resource references at all', async () => {
      const directive = (await onScreen()).response.directives?.[0];
      const json = JSON.stringify(directive);
      expect(json).not.toContain('${');
      expect(json).not.toMatch(/"@[a-zA-Z]/);
      expect(json).not.toContain('datasources');
    });

    it('sends no APL to a device without a screen', async () => {
      const response = (await report()).response;
      expect(response.directives).toBeUndefined();
      expect(response.card).toBeDefined();
    });

    it.each([
      ['hoy', 'day'],
      ['ayer', 'yesterday'],
      ['esta semana', 'week'],
      ['del mes', 'month'],
      [undefined, 'day'],
    ])('reads %s as the %s period', async (spoken, expected) => {
      await report(spoken);
      expect(assistant.businessReport).toHaveBeenCalledWith(
        actor,
        bella,
        expected,
      );
    });
  });

  /**
   * La primera prueba en la Echo Show fue con "quién me debe" y no se vio
   * nada: el APL estaba solo en business_report. Estos tests fijan que los
   * intents que se preguntan a diario también pinten pantalla.
   */
  describe('screen for the everyday intents', () => {
    const onScreen = (intent: string) =>
      send({
        ...envelope('IntentRequest', intent, {
          negocio: { name: 'negocio', value: 'bella chic' },
        }),
        context: {
          System: {
            application: { applicationId: skillId },
            device: {
              supportedInterfaces: { 'Alexa.Presentation.APL': {} },
            },
          },
        },
      });

    const directiveOf = (response: { directives?: unknown[] }) =>
      response.directives?.[0] as { type: string; token: string };

    it('draws the debt panel for quién me debe', async () => {
      const { response } = await onScreen('pending_payment');
      const directive = directiveOf(response);
      expect(directive.type).toBe('Alexa.Presentation.APL.RenderDocument');
      expect(directive.token).toBe('lynko-debt');
      expect(textsOf(directive)).toEqual([
        'Bella Chic',
        'Cartera',
        'POR COBRAR',
        formatCOP(180000),
        '3 ventas sin cobrar',
        'Marcela Ruiz',
        formatCOP(120000),
        'Iván Pardo',
        formatCOP(60000),
      ]);
      // Y la tarjeta, que es lo único que llega al teléfono.
      expect((response.card as { title: string }).title).toBe(
        'Por cobrar · Bella Chic',
      );
    });

    it('draws the sales panel with the period figures', async () => {
      const { response } = await onScreen('sales_summary');
      const directive = directiveOf(response);
      expect(directive.token).toBe('lynko-sales');
      expect(textsOf(directive)).toEqual([
        'Bella Chic',
        'Hoy',
        'VENTAS',
        formatCOP(840000),
        '6 ventas · 14 und',
        'Ticket promedio',
        formatCOP(140000),
        'Margen',
        '38.5%',
        'Fiado',
        formatCOP(120000),
      ]);
      expect((response.card as { title: string }).title).toBe(
        'Ventas · Bella Chic',
      );
    });

    it('still sends only the card to a device without a screen', async () => {
      const { response } = await send(
        envelope('IntentRequest', 'pending_payment', {
          negocio: { name: 'negocio', value: 'bella chic' },
        }),
      );
      expect(response.directives).toBeUndefined();
      expect(response.card).toBeDefined();
    });
  });

  describe('inventory', () => {
    const ask = async (intent: string) => {
      const result = await send(
        envelope('IntentRequest', intent, {
          negocio: { name: 'negocio', value: 'bella chic' },
        }),
      );
      return (result.response.outputSpeech as { text: string }).text;
    };

    it('names at most three low stock products and flags the sold out ones', async () => {
      expect(await ask('low_stock')).toBe(
        'En Bella Chic hay 4 productos bajos de stock, 1 de ellos agotados. Los más bajos: Base líquida, agotado; Rímel negro, 2; Labial rojo, 4.',
      );
    });

    it('separates sold out from merely low, naming at most three', async () => {
      // Lo bajo se repone esta semana; lo agotado se está dejando de vender hoy.
      // Mezclarlos obliga a oír la lista entera para encontrar los ceros.
      expect(await ask('out_of_stock')).toBe(
        'En Bella Chic tienes 1 producto agotado. Es: Base líquida.',
      );
    });

    it('when nothing is sold out, still flags what is low', async () => {
      assistant.inventoryStatus!.mockResolvedValue({
        business: bella,
        trackedProducts: 40,
        totalUnits: 320,
        valueAtCostCOP: 4500000,
        valueAtPriceCOP: 7200000,
        lowStock: [{ name: 'Rímel negro', stock: 2, minStock: 5 }],
        lowStockCount: 1,
        outOfStockCount: 0,
      });
      expect(await ask('out_of_stock')).toBe(
        'En Bella Chic no tienes nada agotado. Eso sí, 1 producto está por debajo del mínimo.',
      );
    });

    it('values the inventory at cost, not at sale price', async () => {
      const speech = await ask('inventory_value');
      expect(speech).toBe(
        'En Bella Chic tienes 320 unidades en 40 productos, por 4500000 pesos al costo.',
      );
      expect(speech).not.toContain('7200000');
    });

    it('says so when nothing is below the minimum', async () => {
      assistant.inventoryStatus!.mockResolvedValue({
        business: bella,
        trackedProducts: 40,
        totalUnits: 320,
        valueAtCostCOP: 4500000,
        valueAtPriceCOP: 7200000,
        lowStock: [],
        lowStockCount: 0,
        outOfStockCount: 0,
      });
      expect(await ask('low_stock')).toBe(
        'En Bella Chic ningún producto está por debajo del mínimo.',
      );
    });

    it('explains a retail query aimed at another vertical', async () => {
      assistant.inventoryStatus!.mockRejectedValue(
        new BadRequestException('Tenant is not a retail vertical'),
      );
      const result = await send(
        envelope('IntentRequest', 'low_stock', {
          negocio: { name: 'negocio', value: 'malexca' },
        }),
      );
      expect((result.response.outputSpeech as { text: string }).text).toBe(
        'Esa consulta es de tiendas, y ese negocio no lo es.',
      );
    });
  });

  describe('platform overview speech', () => {
    const ask = async () => {
      const result = await send(
        envelope('IntentRequest', 'GetSubscriptionsIntent'),
      );
      return (result.response.outputSpeech as { text: string }).text;
    };

    it('queries as the authorized actor', async () => {
      await ask();
      expect(assistant.platformOverview).toHaveBeenCalledWith(actor);
    });

    it('mentions trialing and past due only when there are any', async () => {
      assistant.platformOverview.mockResolvedValue({
        ...overview,
        subscriptions: { active: 1, trialing: 2, pastDue: 1, billable: 4 },
      });
      expect(await ask()).toBe(
        'Tienes 1 suscripción activa, 2 en prueba y 1 en mora, sobre 4 negocios en total. Este mes has recibido 2 pagos por 300000 pesos.',
      );
    });

    it('never speaks the MRR: counts list price, not collected money', async () => {
      expect(await ask()).not.toContain('450000');
    });

    it('says plainly when nothing was collected this month', async () => {
      assistant.platformOverview.mockResolvedValue({
        ...overview,
        payments: { month: '2026-09', count: 0, totalCOP: 0 },
      });
      expect(await ask()).toBe(
        'Tienes 3 suscripciones activas, sobre 4 negocios en total. Este mes todavía no has recibido pagos.',
      );
    });
  });

  it('ends a session without speech', async () => {
    expect(await send(envelope('SessionEndedRequest'))).toEqual({
      version: '1.0',
      response: {},
    });
  });
  it('verifies the exact original bytes and headers', async () => {
    const raw = JSON.stringify(envelope(), null, 2);
    const headers = { 'signature-256': 'test-signature' };
    const timestamp = jest.spyOn(TimestampVerifier.prototype, 'verify');
    await service.handleRequest(Buffer.from(raw), headers);
    expect(signature).toHaveBeenCalledWith(raw, headers);
    expect(timestamp).toHaveBeenCalledWith(raw);
  });
  it('rejects invalid signatures', async () => {
    signature.mockRejectedValue(new Error('Invalid signature'));
    await expect(send(envelope())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
  it('rejects unsigned requests using the real verifier', async () => {
    signature.mockRestore();
    await expect(send(envelope())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
  it.each([
    'invalid',
    new Date(Date.now() - 200000).toISOString(),
    new Date(Date.now() + 200000).toISOString(),
  ])('rejects timestamp %s', async (timestamp) => {
    const body = envelope();
    body.request.timestamp = timestamp;
    await expect(send(body)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('accepts the application ID in session alone', async () => {
    const { context, ...body } = envelope();
    expect(
      await send({
        ...body,
        session: { application: context.System.application },
      }),
    ).toHaveProperty('version', '1.0');
  });
  it('rejects conflicting application IDs', async () => {
    await expect(
      send({
        ...envelope(),
        session: { application: { applicationId: 'other-skill' } },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a different skill', async () => {
    skills.byApplicationId.mockResolvedValue(null);
    const body = envelope();
    body.context.System.application.applicationId = 'other-skill';
    await expect(send(body)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('rejects missing application IDs', async () => {
    const body = { ...envelope(), context: {} };
    await expect(send(body)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it.each([undefined, Buffer.from('invalid json'), Buffer.from('{}')])(
    'rejects absent or malformed body',
    async (body) => {
      await expect(service.handleRequest(body, {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    },
  );
  it('rejects a skill that is not registered', async () => {
    skills.byApplicationId.mockResolvedValue(null);
    await expect(send(envelope())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('resolves the tenant from the applicationId Amazon signed', async () => {
    await send(envelope());
    expect(skills.byApplicationId).toHaveBeenCalledWith('test-skill');
  });
});
