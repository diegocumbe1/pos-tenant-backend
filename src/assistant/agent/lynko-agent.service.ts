import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { AssistantChannel } from '@prisma/client';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import { AssistantScopeService, BusinessRef } from '../assistant-scope.service';
import { AssistantService } from '../assistant.service';
import { ReportPeriod } from '../assistant.types';
import {
  ConversationService,
  ConversationState,
} from '../conversation/conversation.service';
import {
  AgentIntent,
  IntentMatch,
  IntentResolverService,
} from '../intents/intent-resolver.service';
import {
  IdentityResolverService,
  ResolvedIdentity,
} from '../identity/identity-resolver.service';
import { AgentRequest, AgentResult } from './agent.types';
import {
  MenuOption,
  capabilityUnavailableText,
  debtText,
  deliveryText,
  intentNeedsRetail,
  inventoryValueText,
  lowStockText,
  menuFor,
  rankingText,
  renderMenu,
  salesText,
} from './reply.text';

/** Un negocio consultable y la cuenta con la que se consulta. */
interface Scope {
  business: BusinessRef;
  actor: AuthenticatedUser;
}

const BUSINESS_PREFIX = 'business:';

const UNKNOWN_WELCOME = [
  '¡Hola! 👋 Bienvenido a Lynko.',
  'Soy el asistente de nuestro equipo. ¿En qué podemos ayudarte?',
].join('\n');

const UNKNOWN_MENU: MenuOption[] = [
  { value: 'about_lynko', label: 'Quiero conocer Lynko' },
  { value: 'demo_request', label: 'Quiero una demostración' },
  { value: 'human_handoff', label: 'Necesito soporte' },
  { value: 'existing_customer', label: 'Ya soy cliente de Lynko' },
];

/**
 * El agente de Lynko. Un canal le entrega un mensaje y le devuelve qué hacer.
 *
 * Es el núcleo del que hablábamos: WhatsApp es un adaptador de cien líneas por
 * encima de esto, Alexa ya tiene el suyo, y el chat web puede tener otro. La
 * lógica de negocio no vive aquí —vive en `AssistantService`, que es el mismo
 * que usa Alexa—; aquí vive el *criterio*: quién escribe, de qué negocio
 * hablamos, y si hay que responder.
 *
 * Tres cosas separadas a propósito:
 *
 *   identidad   ¿quién es este número?            IdentityResolverService
 *   sesión      ¿de qué veníamos hablando?        ConversationService
 *   decisión    ¿respondo, pregunto, o me callo?  este servicio
 *
 * Y una regla que no se negocia: **conocer el número no autoriza nada**. El
 * teléfono solo decide con qué cuenta se trabaja; qué puede ver esa cuenta lo
 * siguen decidiendo `accessibleBusinesses` y `assertPermission`, que son los
 * mismos de la app.
 */
@Injectable()
export class LynkoAgentService {
  private readonly logger = new Logger('LynkoAgent');

  constructor(
    private readonly identity: IdentityResolverService,
    private readonly conversations: ConversationService,
    private readonly intents: IntentResolverService,
    private readonly scope: AssistantScopeService,
    private readonly assistant: AssistantService,
  ) {}

  async process(request: AgentRequest): Promise<AgentResult> {
    const { channel, externalUserId } = request;
    const message = (request.message ?? '').trim();
    if (!message) {
      return this.ignore('empty message', channel);
    }

    const state = await this.conversations.load(channel, externalUserId);
    if (state.humanActive) {
      // Alguien del equipo está atendiendo este chat. Aquí NO se responde, ni
      // siquiera "un momento": dos voces en la misma conversación es peor que
      // ninguna.
      return this.ignore('human is handling this chat', channel);
    }

    const remembered = this.conversations.optionsOf(state.row);
    const match = this.intents.resolve(message, remembered.length);
    const identity = await this.identity.resolveByPhone(externalUserId);

    if (!identity.actors.length) {
      return this.strangerFlow(
        request,
        identity,
        match,
        remembered,
        state.stale,
      );
    }
    return this.knownFlow(request, identity, match, remembered, state);
  }

  // ─── Desconocidos ─────────────────────────────────────────────────────────
  // Sin cuenta no se nombra ningún negocio, ni se confirma que un número esté
  // asociado a alguno: eso es enumerar tenants. Lo único que cambia si la
  // persona es un contacto conocido es que se le llama por su nombre.

  private async strangerFlow(
    request: AgentRequest,
    identity: ResolvedIdentity,
    match: IntentMatch,
    remembered: MenuOption[],
    stale: boolean,
  ): Promise<AgentResult> {
    const { channel, externalUserId } = request;
    const intent = this.effectiveIntent(match, remembered);

    if (intent === 'human_handoff') {
      await this.conversations.remember(channel, externalUserId, {
        lastIntent: intent,
        lastOptions: null,
      });
      return {
        action: 'HUMAN_HANDOFF',
        reply:
          'Con gusto. Ya le paso tu mensaje a alguien del equipo de Lynko y te escribe por aquí.',
        reason: 'user asked for a human',
        context: { personId: null, tenantId: null, intent },
      };
    }

    const reply =
      intent === 'about_lynko'
        ? 'Lynko es el sistema con el que un negocio maneja ventas, inventario, caja y clientes desde el celular o el computador. ¿Quieres que te muestren cómo funciona con tu negocio?'
        : intent === 'demo_request'
          ? 'Perfecto. Cuéntame qué tipo de negocio tienes (tienda, restaurante, barbería) y alguien del equipo te contacta para mostrarte Lynko.'
          : intent === 'existing_customer'
            ? [
                'No encontramos este número asociado a una cuenta de Lynko.',
                'Podemos ayudarte a verificar tu información: escríbeme el nombre del negocio y le paso el caso a alguien del equipo.',
              ].join('\n')
            : [
                stale || !identity.firstName
                  ? identity.firstName
                    ? `¡Hola, ${identity.firstName}! 👋 Bienvenido a Lynko.\nSoy el asistente de nuestro equipo. ¿En qué podemos ayudarte?`
                    : UNKNOWN_WELCOME
                  : '¿En qué te puedo ayudar?',
                renderMenu(UNKNOWN_MENU),
              ].join('\n\n');

    const offersMenu = ![
      'about_lynko',
      'demo_request',
      'existing_customer',
    ].includes(intent);
    await this.conversations.remember(channel, externalUserId, {
      personId: null,
      tenantId: null,
      lastIntent: intent,
      lastOptions: offersMenu ? UNKNOWN_MENU : null,
      greeted: true,
      repliedByAgent: true,
    });

    // "Ya soy cliente" con un número que no resuelve es un caso para una
    // persona: puede ser un socio, un empleado nuevo, o un número que cambió.
    if (intent === 'existing_customer') {
      return {
        action: 'HUMAN_HANDOFF',
        reply,
        reason: 'claims to be a customer but the phone resolves to no account',
        context: { personId: null, tenantId: null, intent },
      };
    }
    return {
      action: offersMenu ? 'CLARIFY' : 'RESPOND',
      reply,
      context: { personId: null, tenantId: null, intent },
    };
  }

  // ─── Conocidos ────────────────────────────────────────────────────────────

  private async knownFlow(
    request: AgentRequest,
    identity: ResolvedIdentity,
    match: IntentMatch,
    remembered: MenuOption[],
    state: ConversationState,
  ): Promise<AgentResult> {
    const { channel, externalUserId } = request;
    const personId = identity.actors[0].actor.id;

    // La lista SIEMPRE sale de los negocios autorizados de cada cuenta, nunca
    // de lo que diga el mensaje. Un admin de plataforma ve todos; un dueño, el
    // suyo. Es la misma regla que aplica Alexa.
    const scopes = await this.accessibleScopes(identity);
    if (!scopes.length) {
      await this.conversations.remember(channel, externalUserId, {
        personId,
        lastIntent: 'human_handoff',
        lastOptions: null,
      });
      return {
        action: 'HUMAN_HANDOFF',
        reply: `Hola${identity.firstName ? `, ${identity.firstName}` : ''}. Tu cuenta no tiene ningún negocio activo para consultar. Le paso el caso a alguien del equipo.`,
        reason: 'no accessible businesses',
        context: { personId, tenantId: null, intent: 'human_handoff' },
      };
    }

    const intent = this.effectiveIntent(match, remembered);

    if (intent === 'human_handoff') {
      await this.conversations.remember(channel, externalUserId, {
        personId,
        lastIntent: intent,
        lastOptions: null,
      });
      return {
        action: 'HUMAN_HANDOFF',
        reply:
          'Claro. Le paso tu mensaje a alguien del equipo y te escribe por aquí.',
        reason: 'user asked for a human',
        context: { personId, tenantId: null, intent },
      };
    }

    if (intent === 'goodbye') {
      await this.conversations.remember(channel, externalUserId, {
        personId,
        repliedByAgent: true,
      });
      return {
        action: 'RESPOND',
        reply: 'Con gusto. Aquí estoy si necesitas algo más.',
        context: { personId, tenantId: null, intent },
      };
    }

    // ── Qué negocio ──────────────────────────────────────────────────────────
    const selectedBusinessId = this.selectedBusinessId(match, remembered);
    const hint = match.businessHint;
    let scope: Scope | null = null;

    if (selectedBusinessId) {
      scope = scopes.find((s) => s.business.id === selectedBusinessId) ?? null;
    } else if (hint) {
      const matches = scopes.filter((s) => nameMatches(s.business.name, hint));
      // Un nombre que no esté entre los suyos NO existe para esta conversación.
      // No se dice "no tienes acceso a ese negocio": eso ya confirmaría que
      // existe.
      if (matches.length === 1) scope = matches[0];
      else if (matches.length === 0) {
        return this.askForBusiness(
          request,
          personId,
          scopes,
          `No encuentro un negocio tuyo que se llame así.`,
          intent,
        );
      }
    }

    if (!scope) {
      // El negocio recordado es una comodidad, no un permiso: se vuelve a
      // validar contra los negocios autorizados en cada mensaje.
      const rememberedId = state.row?.tenantId ?? null;
      const still = rememberedId
        ? scopes.find((s) => s.business.id === rememberedId)
        : null;
      if (still && intent !== 'switch_business') scope = still;
      else if (scopes.length === 1 && intent !== 'switch_business')
        scope = scopes[0];
    }

    if (!scope) {
      const greeting = state.stale
        ? `¡Hola${identity.firstName ? `, ${identity.firstName}` : ''}! 👋`
        : null;
      return this.askForBusiness(
        request,
        personId,
        scopes,
        [greeting, '¿Sobre cuál negocio quieres consultar?']
          .filter(Boolean)
          .join('\n'),
        intent,
        state.stale,
      );
    }

    // ── Qué se pregunta ──────────────────────────────────────────────────────
    if (
      intent === 'switch_business' ||
      intent === 'options' ||
      intent === 'welcome'
    ) {
      return this.offerMenu(request, personId, scope, identity, state.stale);
    }

    if (intent === 'unknown') {
      // "¿Y ayer?" reusa la última capacidad con el período nuevo. Si no hay
      // nada que reusar, se ofrece el menú en vez de adivinar.
      const previous = state.row && this.previousIntent(state.row);
      if (match.period && previous && intentNeedsRetail(previous)) {
        return this.answer(request, personId, scope, previous, match.period);
      }
      return this.offerMenu(request, personId, scope, identity, state.stale);
    }

    return this.answer(
      request,
      personId,
      scope,
      intent,
      match.period,
      state.stale ? identity.firstName : null,
    );
  }

  // ─── Ejecución de una capacidad ───────────────────────────────────────────

  private async answer(
    request: AgentRequest,
    personId: string,
    scope: Scope,
    intent: AgentIntent,
    period: ReportPeriod | null,
    greetWith: string | null = null,
  ): Promise<AgentResult> {
    const { channel, externalUserId } = request;
    const { actor, business } = scope;
    const effectivePeriod = period ?? 'day';

    try {
      const body = await this.capability(
        actor,
        business,
        intent,
        effectivePeriod,
      );
      const reply = greetWith ? `¡Hola, ${greetWith}! 👋\n${body}` : body;
      await this.conversations.remember(channel, externalUserId, {
        personId,
        tenantId: business.id,
        lastIntent: intent,
        lastSlots: { period: effectivePeriod },
        lastOptions: null,
        greeted: true,
        repliedByAgent: true,
      });
      return {
        action: 'RESPOND',
        reply,
        context: this.contextOf(personId, scope, intent),
      };
    } catch (error) {
      return this.explainFailure(request, personId, scope, intent, error);
    }
  }

  /**
   * Las capacidades: las MISMAS que consume Alexa, sin una línea de lógica de
   * negocio repetida. Si mañana hay que arreglar cómo se cuenta una venta, se
   * arregla en un solo sitio y los dos canales lo heredan.
   */
  private async capability(
    actor: AuthenticatedUser,
    business: BusinessRef,
    intent: AgentIntent,
    period: ReportPeriod,
  ): Promise<string> {
    switch (intent) {
      case 'sales_summary':
        return salesText(await this.assistant.sales(actor, business, period));
      case 'pending_payment':
        return debtText(await this.assistant.pendingPayment(actor, business));
      case 'pending_delivery':
        return deliveryText(
          await this.assistant.pendingDelivery(actor, business),
        );
      case 'low_stock':
        return lowStockText(
          await this.assistant.inventoryStatus(actor, business),
        );
      case 'inventory_value':
        return inventoryValueText(
          await this.assistant.inventoryStatus(actor, business),
        );
      case 'top_products':
        return rankingText(
          await this.assistant.salesRanking(actor, business, period),
        );
      case 'business_report': {
        const report = await this.assistant.businessReport(
          actor,
          business,
          period,
        );
        return [
          salesText({ business, period, ...report.sales }),
          debtText({ business, ...report.debt }),
          lowStockText({ business, ...report.inventory }),
        ].join('\n\n');
      }
      default:
        return capabilityUnavailableText(
          business.name,
          business.vertical?.code,
        );
    }
  }

  /**
   * Por qué no se pudo responder, en palabras del usuario.
   *
   * Los dos casos que de verdad pasan son los mismos que ya traduce Alexa: el
   * rol no tiene el permiso, o el negocio no es de la vertical que sabe
   * responder esa pregunta. Cualquier otro error se escala: el agente no
   * improvisa una cifra ni una explicación.
   */
  private async explainFailure(
    request: AgentRequest,
    personId: string,
    scope: Scope,
    intent: AgentIntent,
    error: unknown,
  ): Promise<AgentResult> {
    const { channel, externalUserId } = request;
    const { business } = scope;
    await this.conversations.remember(channel, externalUserId, {
      personId,
      tenantId: business.id,
      lastIntent: intent,
      repliedByAgent: true,
    });

    if (error instanceof ForbiddenException) {
      this.logger.warn(`Denied: role lacks permission for ${intent}`);
      return {
        action: 'RESPOND',
        reply: 'Tu usuario no tiene permiso para esa consulta.',
        context: this.contextOf(personId, scope, intent),
      };
    }
    if (error instanceof BadRequestException) {
      // Consulta de tienda contra un negocio de otra vertical.
      return {
        action: 'RESPOND',
        reply: capabilityUnavailableText(
          business.name,
          business.vertical?.code,
        ),
        context: this.contextOf(personId, scope, intent),
      };
    }
    this.logger.error(
      `Capability ${intent} failed: ${(error as Error)?.message ?? 'unknown'}`,
    );
    return {
      action: 'HUMAN_HANDOFF',
      reply:
        'No pude sacar ese dato en este momento. Le aviso a alguien del equipo para que lo revise.',
      reason: 'capability threw',
      context: this.contextOf(personId, scope, intent),
    };
  }

  // ─── Menús (el fallback, no la interfaz) ──────────────────────────────────

  private async offerMenu(
    request: AgentRequest,
    personId: string,
    scope: Scope,
    identity: ResolvedIdentity,
    stale: boolean,
  ): Promise<AgentResult> {
    const { channel, externalUserId } = request;
    const options = menuFor(scope.business.vertical?.code);
    const header = stale
      ? [
          `¡Hola${identity.firstName ? `, ${identity.firstName}` : ''}! 👋`,
          `Qué gusto tenerte por aquí. Veo que estás en ${scope.business.name}.`,
          '¿En qué te puedo ayudar?',
        ].join('\n')
      : `¿Qué quieres consultar de ${scope.business.name}?`;

    await this.conversations.remember(channel, externalUserId, {
      personId,
      tenantId: scope.business.id,
      lastIntent: 'options',
      lastOptions: options,
      greeted: true,
      repliedByAgent: true,
    });
    return {
      action: 'CLARIFY',
      reply: `${header}\n\n${renderMenu(options)}`,
      context: this.contextOf(personId, scope, 'options'),
    };
  }

  private async askForBusiness(
    request: AgentRequest,
    personId: string,
    scopes: Scope[],
    header: string,
    intent: AgentIntent,
    greeted = false,
  ): Promise<AgentResult> {
    const { channel, externalUserId } = request;
    const options: MenuOption[] = scopes.map((s) => ({
      value: `${BUSINESS_PREFIX}${s.business.id}`,
      label: s.business.name,
    }));
    await this.conversations.remember(channel, externalUserId, {
      personId,
      lastIntent: intent,
      lastOptions: options,
      greeted: greeted || undefined,
      repliedByAgent: true,
    });
    return {
      action: 'CLARIFY',
      reply: `${header}\n\n${renderMenu(options)}`,
      context: { personId, tenantId: null, intent },
    };
  }

  // ─── Apoyos ───────────────────────────────────────────────────────────────

  /**
   * Los negocios que este teléfono puede consultar, y con qué cuenta cada uno.
   *
   * Una persona con dos negocios son dos cuentas (`User` es de un solo tenant),
   * así que se recorren todas y se unen sin repetir. El rol que se usa para
   * responder es el de la cuenta dueña de ese negocio, no el de la primera que
   * resolvió.
   */
  private async accessibleScopes(identity: ResolvedIdentity): Promise<Scope[]> {
    const byBusiness = new Map<string, Scope>();
    for (const { actor } of identity.actors) {
      const businesses = await this.scope.accessibleBusinesses(actor);
      for (const business of businesses) {
        if (!byBusiness.has(business.id)) {
          byBusiness.set(business.id, { business, actor });
        }
      }
    }
    return [...byBusiness.values()];
  }

  /** Un "2" se convierte en lo que se ofreció como opción 2, y nada más. */
  private effectiveIntent(
    match: IntentMatch,
    remembered: MenuOption[],
  ): AgentIntent {
    if (match.intent !== 'select_option' || !match.optionIndex) {
      return match.intent;
    }
    const chosen = remembered[match.optionIndex - 1]?.value;
    if (!chosen) return 'unknown';
    if (chosen.startsWith(BUSINESS_PREFIX)) return 'options';
    return chosen as AgentIntent;
  }

  private selectedBusinessId(
    match: IntentMatch,
    remembered: MenuOption[],
  ): string | null {
    if (match.intent !== 'select_option' || !match.optionIndex) return null;
    const chosen = remembered[match.optionIndex - 1]?.value ?? '';
    return chosen.startsWith(BUSINESS_PREFIX)
      ? chosen.slice(BUSINESS_PREFIX.length)
      : null;
  }

  /** El contexto que sale con la respuesta: sin él la telemetría no sabe de qué vertical habla. */
  private contextOf(
    personId: string,
    scope: Scope,
    intent: AgentIntent,
  ): AgentResult['context'] {
    return {
      personId,
      tenantId: scope.business.id,
      intent,
      vertical: scope.business.vertical?.code ?? null,
      roleCode: scope.actor.roleCode,
    };
  }

  private previousIntent(row: {
    lastIntent?: string | null;
  }): AgentIntent | null {
    return (row.lastIntent as AgentIntent | undefined) ?? null;
  }

  private ignore(reason: string, channel: AssistantChannel): AgentResult {
    this.logger.debug(`Ignored message on ${channel}: ${reason}`);
    return {
      action: 'IGNORE',
      reason,
      context: { personId: null, tenantId: null, intent: 'unknown' },
    };
  }
}

/** Mismo criterio flexible que usa Alexa para los nombres de negocio. */
function nameMatches(name: string, hint: string): boolean {
  const clean = (value: string) =>
    value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const a = clean(name);
  const b = clean(hint);
  return (
    !!b && (a === b || a.startsWith(b) || b.startsWith(a) || a.includes(b))
  );
}
