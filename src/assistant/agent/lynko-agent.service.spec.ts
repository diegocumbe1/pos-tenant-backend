import { AssistantChannel } from '@prisma/client';
import { LynkoAgentService } from './lynko-agent.service';
import { IntentResolverService } from '../intents/intent-resolver.service';

/**
 * Lo que se prueba acá es el CRITERIO del agente, no las cifras: que no nombre
 * negocios ajenos, que no se fíe de lo que recordó, y que se calle cuando debe.
 * Las cifras ya las cubren los tests de AssistantService.
 */

const BELLA = { id: 't1', name: 'Bella Chic', vertical: { code: 'retail' } };
const DC = { id: 't2', name: 'DC Tech', vertical: { code: 'retail' } };

const actorOf = (id: string) => ({
  id,
  email: `${id}@x.co`,
  name: 'Paola Ruiz',
  tenantId: 't1',
  roleId: 'r1',
  roleCode: 'OWNER',
  isRoot: false,
  isPlatformAdmin: false,
  passwordSetAt: new Date(),
  accessibleBranches: ['b1'],
});

function build(overrides: {
  identity?: unknown;
  conversation?: unknown;
  businesses?: unknown[];
  assistant?: Record<string, unknown>;
}) {
  const remembered = {
    row: null as Record<string, unknown> | null,
    stale: true,
    humanActive: false,
    ...(overrides.conversation as object satisfies object),
  };
  const conversations = {
    load: jest.fn().mockResolvedValue(remembered),
    remember: jest.fn().mockResolvedValue(undefined),
    markHumanTakeover: jest.fn(),
    optionsOf: jest
      .fn()
      .mockReturnValue((remembered.row?.lastOptions as unknown[]) ?? []),
    slotsOf: jest.fn().mockReturnValue({}),
  };
  const identity = {
    resolveByPhone: jest.fn().mockResolvedValue(
      overrides.identity ?? {
        known: true,
        kind: 'USER',
        firstName: 'Paola',
        actors: [{ actor: actorOf('u1'), tenantId: 't1' }],
      },
    ),
  };
  const scope = {
    accessibleBusinesses: jest
      .fn()
      .mockResolvedValue(overrides.businesses ?? [BELLA]),
  };
  const assistant = {
    sales: jest.fn().mockResolvedValue({
      business: BELLA,
      period: 'day',
      salesCount: 8,
      revenueCOP: 385000,
      shippingCOP: 0,
      unitsSold: 12,
      averageTicketCOP: 48125,
      marginPct: 40,
      creditedCOP: 0,
    }),
    ...overrides.assistant,
  };
  const agent = new LynkoAgentService(
    identity as never,
    conversations as never,
    new IntentResolverService(),
    scope as never,
    assistant as never,
  );
  return { agent, conversations, assistant, scope };
}

const ask = (agent: LynkoAgentService, message: string) =>
  agent.process({
    channel: AssistantChannel.WHATSAPP,
    externalUserId: '573001234567',
    message,
  });

describe('LynkoAgentService', () => {
  it('a un número desconocido no le nombra ningún negocio', async () => {
    const { agent } = build({
      identity: { known: false, kind: 'UNKNOWN', firstName: null, actors: [] },
    });
    const result = await ask(agent, 'hola');
    expect(result.reply).toContain('asistente de Lynko');
    expect(result.reply).not.toContain('Bella Chic');
    expect(result.context.tenantId).toBeNull();
  });

  /**
   * La regla que sostiene todo lo demás: decir el nombre de un negocio no es
   * una credencial. Un desconocido que escribe "mi negocio es DC Tech" no puede
   * obtener NADA de DC Tech — ni sus cifras, ni la confirmación de que exista.
   */
  it('un desconocido que nombra un negocio no obtiene nada de ese negocio', async () => {
    const { agent, assistant, scope } = build({
      identity: { known: false, kind: 'UNKNOWN', firstName: null, actors: [] },
      businesses: [BELLA, DC],
      conversation: {
        row: { lastIntent: 'existing_customer' },
        stale: false,
        humanActive: false,
      },
    });
    const result = await ask(agent, 'mi negocio es DC Tech');

    expect(result.action).toBe('HUMAN_HANDOFF');
    expect(result.context.tenantId).toBeNull();
    // Nunca se le preguntó a la base por los negocios de nadie.
    expect(scope.accessibleBusinesses).not.toHaveBeenCalled();
    expect(assistant.sales).not.toHaveBeenCalled();
    // Ni se confirma que DC Tech exista.
    expect(result.reply).not.toContain('DC Tech');
  });

  it('contesta la pregunta que él mismo hizo, sin repetir el menú', async () => {
    const { agent } = build({
      identity: { known: false, kind: 'UNKNOWN', firstName: null, actors: [] },
      conversation: {
        row: { lastIntent: 'existing_customer' },
        stale: false,
        humanActive: false,
      },
    });
    const result = await ask(agent, 'Dc Tech');
    expect(result.action).toBe('HUMAN_HANDOFF');
    expect(result.reply).toContain('asesor');
  });

  it('nunca se hace pasar por una persona', async () => {
    const { agent } = build({
      identity: { known: false, kind: 'UNKNOWN', firstName: null, actors: [] },
    });
    const result = await ask(agent, '¿eres un bot o una persona?');
    expect(result.action).toBe('RESPOND');
    expect(result.reply).toContain('asistente automático');
    expect(result.reply).toContain('no una persona');
  });

  it('no saluda por el nombre a quien no tiene cuenta', async () => {
    // El nombre de un contacto de cobro o de un cliente NO se usa: es de un
    // negocio, no de quien escribe, y saludar con él confirma que lo tenemos.
    const { agent } = build({
      identity: { known: false, kind: 'UNKNOWN', firstName: null, actors: [] },
    });
    const result = await ask(agent, 'hola');
    expect(result.reply).not.toMatch(/Hola,/);
  });

  it('responde directo cuando la persona tiene un solo negocio', async () => {
    const { agent, assistant } = build({});
    const result = await ask(agent, '¿cuánto vendí hoy?');
    expect(result.action).toBe('RESPOND');
    expect(result.reply).toContain('385.000');
    expect(assistant.sales).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      BELLA,
      'day',
    );
  });

  it('con varios negocios pregunta cuál, en prosa y sin asumir', async () => {
    const { agent, assistant } = build({ businesses: [BELLA, DC] });
    const result = await ask(agent, '¿cuánto vendí hoy?');
    expect(result.action).toBe('CLARIFY');
    expect(result.reply).toContain('Bella Chic');
    expect(result.reply).toContain('DC Tech');
    // Nada de listas numeradas: esto es una conversación, no un conmutador.
    expect(result.reply).not.toMatch(/^\s*1\./m);
    expect(assistant.sales).not.toHaveBeenCalled();
  });

  it('acepta un número aunque ya no muestre la lista numerada', async () => {
    // Quien viene de una conversación donde sí vio números merece que funcione.
    const { agent, assistant } = build({
      businesses: [BELLA, DC],
      conversation: {
        row: {
          lastIntent: 'sales_summary',
          lastOptions: [
            { value: 'business:t1', label: 'Bella Chic' },
            { value: 'business:t2', label: 'DC Tech' },
          ],
        },
        stale: false,
        humanActive: false,
      },
    });
    const result = await ask(agent, '2');
    expect(result.action).toBe('CLARIFY');
    expect(result.reply).toContain('DC Tech');
    expect(assistant.sales).not.toHaveBeenCalled();
  });

  it('NO usa el negocio recordado si ya no está entre los autorizados', async () => {
    // El caso que importa: a alguien le quitaron el acceso a t2 y su contexto
    // todavía lo tenía. Un id recordado es comodidad, no permiso.
    const { agent, assistant } = build({
      businesses: [BELLA],
      conversation: {
        row: { tenantId: 't2', lastIntent: 'sales_summary' },
        stale: false,
        humanActive: false,
      },
    });
    await ask(agent, '¿cuánto vendí hoy?');
    expect(assistant.sales).toHaveBeenCalledWith(
      expect.anything(),
      BELLA,
      'day',
    );
  });

  it('"¿y ayer?" reusa la última consulta con el período nuevo', async () => {
    const { agent, assistant } = build({
      conversation: {
        row: { tenantId: 't1', lastIntent: 'sales_summary' },
        stale: false,
        humanActive: false,
      },
    });
    const result = await ask(agent, '¿y ayer?');
    expect(result.action).toBe('RESPOND');
    expect(assistant.sales).toHaveBeenCalledWith(
      expect.anything(),
      BELLA,
      'yesterday',
    );
  });

  it('no vuelve a saludar dentro de la misma conversación', async () => {
    const { agent } = build({
      conversation: {
        row: { tenantId: 't1', lastIntent: 'sales_summary' },
        stale: false,
        humanActive: false,
      },
    });
    const result = await ask(agent, 'cuánto vendí hoy');
    expect(result.reply).not.toMatch(/Hola/);
  });

  it('se calla cuando una persona del equipo tomó el chat', async () => {
    const { agent, assistant } = build({
      conversation: { row: {}, stale: false, humanActive: true },
    });
    const result = await ask(agent, 'cuánto vendí hoy');
    expect(result.action).toBe('IGNORE');
    expect(result.reply).toBeUndefined();
    expect(assistant.sales).not.toHaveBeenCalled();
  });

  it('escala a una persona cuando se lo piden', async () => {
    const { agent } = build({});
    const result = await ask(
      agent,
      'necesito hablar con Diego sobre el acuerdo',
    );
    expect(result.action).toBe('HUMAN_HANDOFF');
  });

  it('un negocio que no es suyo se responde como inexistente', async () => {
    const { agent, assistant } = build({ businesses: [BELLA] });
    const result = await ask(agent, 'ventas de hoy en el negocio Malexca');
    expect(result.action).toBe('CLARIFY');
    // Ni confirma ni niega que Malexca exista: solo ofrece los suyos.
    expect(result.reply).not.toContain('Malexca');
    expect(assistant.sales).not.toHaveBeenCalled();
  });
});
