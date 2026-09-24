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
import { handoffTiming } from './business-hours';
import {
  ASK_PERIOD,
  IDENTITY_DISCLOSURE,
  MAX_SPOKEN_BUSINESSES,
  MenuOption,
  SHORT_HINT,
  handoffText,
  businessQuestion,
  capabilityHint,
  capabilityUnavailableText,
  customersText,
  debtText,
  deliveryText,
  expensesText,
  intentNeedsRetail,
  inventoryValueText,
  lowStockText,
  menuFor,
  outOfStockText,
  pendingPurchaseText,
  rankingText,
  salesText,
  strangerInvite,
  unitsSoldText,
  worstProductsText,
} from './reply.text';

/** Un negocio consultable y la cuenta con la que se consulta. */
interface Scope {
  business: BusinessRef;
  actor: AuthenticatedUser;
}

const BUSINESS_PREFIX = 'business:';

/**
 * Las salidas de un desconocido. No se muestran numeradas —ver
 * `strangerInvite`—, pero se guardan para poder entender un "2".
 */
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
    const identity = await this.identity.resolveByPhone(externalUserId);

    // Los negocios se resuelven ANTES de interpretar el mensaje, porque el
    // resolver necesita la lista para reconocer "de bella chic" sin exigir la
    // palabra "negocio". Un desconocido no tiene ninguno, y ahí no hay nada que
    // buscar: la lista vacía también es la respuesta correcta.
    const scopes = identity.actors.length
      ? await this.accessibleScopes(identity)
      : [];
    const match = this.intents.resolve(message, {
      knownOptions: remembered.length,
      businessNames: scopes.map((s) => s.business.name),
    });

    const result = identity.actors.length
      ? await this.knownFlow(
          request,
          identity,
          match,
          remembered,
          state,
          scopes,
        )
      : await this.strangerFlow(request, identity, match, remembered, state);

    // De dónde salió la identidad, para el diagnóstico de la consola. Va aquí y
    // no en cada `return` porque es una propiedad del mensaje entero, no de la
    // rama que lo atendió.
    return {
      ...result,
      context: { ...result.context, identity: identity.kind },
    };
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
    state: ConversationState,
  ): Promise<AgentResult> {
    const { channel, externalUserId } = request;
    const intent = this.effectiveIntent(match, remembered);
    const asked = state.row?.lastIntent ?? null;

    // El agente preguntó algo y esto es la respuesta.
    //
    // Sin esto, pedir "escríbeme el nombre del negocio" y luego no entender
    // "DC Tech" hacía que se repitiera el menú entero: la conversación más
    // frustrante posible, porque el usuario SÍ contestó lo que se le pidió.
    // Aquí no se interpreta el contenido —ni falta—: basta con saber que
    // respondió para pasarle el caso a una persona.
    if (
      intent === 'unknown' &&
      (asked === 'existing_customer' || asked === 'demo_request')
    ) {
      await this.conversations.remember(channel, externalUserId, {
        lastIntent: 'human_handoff',
        lastOptions: null,
        repliedByAgent: true,
      });
      return {
        action: 'HUMAN_HANDOFF',
        reply: handoffText(
          asked === 'existing_customer' ? 'Gracias.' : 'Listo, tomo nota.',
          handoffTiming(),
        ),
        reason: `stranger answered the ${asked} question`,
        context: { personId: null, tenantId: null, intent: 'human_handoff' },
      };
    }

    if (intent === 'human_handoff') {
      await this.conversations.remember(channel, externalUserId, {
        lastIntent: intent,
        lastOptions: null,
      });
      return {
        action: 'HUMAN_HANDOFF',
        reply: handoffText('Con gusto.', handoffTiming()),
        reason: 'user asked for a human',
        context: { personId: null, tenantId: null, intent },
      };
    }

    const reply =
      intent === 'about_lynko'
        ? 'Lynko es el sistema con el que un negocio maneja ventas, inventario, caja y clientes desde el celular o el computador. ¿Quieres que te muestren cómo funciona con tu negocio?'
        : intent === 'is_bot'
          ? IDENTITY_DISCLOSURE
          : intent === 'demo_request'
            ? 'Perfecto. Cuéntame qué tipo de negocio tienes (tienda, restaurante, barbería) y un asesor te contacta para mostrarte Lynko.'
            : intent === 'existing_customer'
              ? [
                  'No encontramos este número asociado a una cuenta de Lynko.',
                  'Escríbeme el nombre del negocio y le paso el caso a un asesor para que verifique tu información.',
                ].join('\n')
              : // Ya se le ofreció ayuda hace un momento: repetir la invitación
                // entera suena a grabación. Se acorta.
                asked === 'welcome' || asked === 'options'
                ? 'No estoy seguro de haber entendido. ¿Buscas información de Lynko, una demostración, o ayuda con una cuenta?'
                : strangerInvite(identity.firstName, state.stale);

    // Las tres opciones siguen guardadas aunque no se muestren numeradas: quien
    // conteste "2" porque vio una lista antes merece que funcione.
    await this.conversations.remember(channel, externalUserId, {
      personId: null,
      tenantId: null,
      lastIntent: intent,
      lastOptions: UNKNOWN_MENU,
      greeted: true,
      repliedByAgent: true,
    });

    // `existing_customer` y `demo_request` PREGUNTAN algo: no son el final de
    // la conversación sino la mitad. El handoff ocurre cuando la persona
    // conteste, arriba. Marcarlos como escalados aquí haría que el equipo
    // recibiera un caso sin el dato que se acaba de pedir.
    return {
      action:
        intent === 'about_lynko' || intent === 'is_bot' ? 'RESPOND' : 'CLARIFY',
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
    /**
     * Los negocios autorizados de este actor. Vienen resueltos desde
     * `process()` porque el resolver de intención también los necesita, y
     * pedirlos dos veces serían dos viajes a la base por cada mensaje.
     *
     * La lista SIEMPRE sale de los negocios autorizados de cada cuenta, nunca
     * de lo que diga el mensaje. Un admin de plataforma ve todos; un dueño, el
     * suyo. Es la misma regla que aplica Alexa.
     */
    scopes: Scope[],
  ): Promise<AgentResult> {
    const { channel, externalUserId } = request;
    const personId = identity.actors[0].actor.id;

    if (!scopes.length) {
      await this.conversations.remember(channel, externalUserId, {
        personId,
        lastIntent: 'human_handoff',
        lastOptions: null,
      });
      return {
        action: 'HUMAN_HANDOFF',
        reply: handoffText(
          `Hola${identity.firstName ? `, ${identity.firstName}` : ''}. Tu cuenta no tiene ningún negocio activo para consultar.`,
          handoffTiming(),
        ),
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
        reply: handoffText('Claro.', handoffTiming()),
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
      // `businessHint` ya viene resuelto contra los negocios autorizados, así
      // que esto encuentra exactamente uno. Se vuelve a filtrar igual porque
      // quien decide sigue siendo la lista, no el texto del mensaje.
      scope = scopes.find((s) => nameMatches(s.business.name, hint)) ?? null;
    } else if (match.unknownBusiness) {
      // Nombró un negocio que no es suyo. Un nombre que no esté entre los suyos
      // NO existe para esta conversación: no se dice "no tienes acceso a ese
      // negocio", porque eso ya confirmaría que existe.
      return this.askForBusiness(
        request,
        personId,
        scopes,
        `No encuentro un negocio tuyo que se llame así.`,
        intent,
      );
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
        greeting,
        intent,
        state.stale,
      );
    }

    // ── Qué se pregunta ──────────────────────────────────────────────────────
    // Que ya se haya ofrecido ayuda en el turno anterior cambia la redacción:
    // decir el mismo párrafo dos veces seguidas es lo que hace que algo suene a
    // contestador.
    const offered = state.row?.lastIntent === 'options';
    if (
      intent === 'switch_business' ||
      intent === 'options' ||
      intent === 'welcome'
    ) {
      return this.offerMenu(
        request,
        personId,
        scope,
        identity,
        state.stale,
        offered && intent !== 'switch_business',
      );
    }

    if (intent === 'unknown') {
      // "¿Y ayer?" reusa la última capacidad con el período nuevo. Si no hay
      // nada que reusar, se dice qué sí se puede preguntar en vez de adivinar.
      const previous = state.row && this.previousIntent(state.row);
      if (match.period && previous && intentNeedsRetail(previous)) {
        return this.answer(request, personId, scope, previous, match.period);
      }
      return this.offerMenu(
        request,
        personId,
        scope,
        identity,
        state.stale,
        offered,
      );
    }

    // Pidió un TOTAL sin decir de cuándo ("¿cuánto llevo en ventas totales?").
    // Se pregunta en vez de asumir: una cifra exacta de la ventana equivocada
    // es peor que una repregunta, y es indistinguible de un error.
    if (match.needsPeriod && intentNeedsPeriod(intent)) {
      await this.conversations.remember(channel, externalUserId, {
        personId,
        tenantId: scope.business.id,
        lastIntent: intent,
        lastOptions: null,
        greeted: true,
        repliedByAgent: true,
      });
      return {
        action: 'CLARIFY',
        reply: ASK_PERIOD,
        context: this.contextOf(personId, scope, intent),
      };
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
    const effectivePeriod = period ?? defaultPeriodFor(intent);

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
      case 'pending_purchase':
        return pendingPurchaseText(
          await this.assistant.pendingPurchase(actor, business),
        );
      case 'expenses_summary':
        return expensesText(
          await this.assistant.expenses(actor, business, period),
        );
      case 'units_sold':
        return unitsSoldText(
          await this.assistant.sales(actor, business, period),
        );
      case 'out_of_stock':
        return outOfStockText(
          await this.assistant.inventoryStatus(actor, business),
        );
      case 'top_products':
        return rankingText(
          await this.assistant.salesRanking(actor, business, period),
        );
      case 'worst_products':
        return worstProductsText(
          await this.assistant.salesRanking(actor, business, period),
        );
      case 'top_customers':
        return customersText(
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
      reply: handoffText(
        'No pude sacar ese dato en este momento.',
        handoffTiming(),
      ),
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
    /** Ya se le dijo qué puede preguntar en el turno anterior. */
    offered = false,
  ): Promise<AgentResult> {
    const { channel, externalUserId } = request;
    const options = menuFor(scope.business.vertical?.code);
    const vertical = scope.business.vertical?.code;
    // Sin lista numerada: se saluda y se dice con un ejemplo qué se puede
    // preguntar. El objetivo es que la siguiente frase del usuario sea una
    // pregunta suya, no el número de una opción.
    const reply = stale
      ? [
          `¡Hola${identity.firstName ? `, ${identity.firstName}` : ''}! 👋 Qué gusto tenerte por aquí.`,
          `Estás en ${scope.business.name}. ${capabilityHint(vertical)}`,
        ].join('\n')
      : offered
        ? SHORT_HINT
        : // Se nombra el negocio: se llega aquí justo después de elegirlo o de
          // cambiarlo, y confirmar con cuál se está trabajando evita que la
          // cifra siguiente se lea sobre el negocio equivocado.
          `Listo, estamos en ${scope.business.name}. ${capabilityHint(vertical)}`;

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
      reply,
      context: this.contextOf(personId, scope, 'options'),
    };
  }

  private async askForBusiness(
    request: AgentRequest,
    personId: string,
    scopes: Scope[],
    header: string | null,
    intent: AgentIntent,
    greeted = false,
  ): Promise<AgentResult> {
    const { channel, externalUserId } = request;
    // Un admin de plataforma ve TODOS los tenants, y una lista de cuarenta
    // negocios en un chat no es una pregunta, es un muro. Se numeran los
    // primeros y para el resto se escribe el nombre, que igual se resuelve
    // contra los autorizados.
    const shown = scopes.slice(0, MAX_SPOKEN_BUSINESSES);
    const options: MenuOption[] = shown.map((s) => ({
      value: `${BUSINESS_PREFIX}${s.business.id}`,
      label: s.business.name,
    }));
    await this.conversations.remember(channel, externalUserId, {
      personId,
      lastIntent: intent,
      // Se recuerdan solo los que se nombraron: si no, un "3" apuntaría a un
      // negocio que el usuario nunca vio.
      lastOptions: options,
      greeted: greeted || undefined,
      repliedByAgent: true,
    });
    const question = businessQuestion(
      shown.map((s) => s.business.name),
      scopes.length,
    );
    return {
      action: 'CLARIFY',
      reply: header ? `${header}\n${question}` : question,
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

/**
 * El período que se asume cuando el mensaje no dice ninguno.
 *
 * No es el mismo para todo, y esa es la gracia: "¿cuánto vendí?" sin más es una
 * pregunta sobre HOY —se hace mirando la caja—, mientras que "¿qué es lo que
 * más vendo?" o "¿cuánto gasto?" con un solo día de datos no responden nada.
 *
 * Sea cual sea, la respuesta SIEMPRE nombra el rango que usó (`periodLabel` en
 * cada texto de `reply.text.ts`): asumir está bien, asumir en silencio no.
 */
function defaultPeriodFor(intent: AgentIntent): ReportPeriod {
  switch (intent) {
    case 'expenses_summary':
    case 'units_sold':
    case 'top_products':
    case 'worst_products':
    case 'top_customers':
      return 'month';
    default:
      return 'day';
  }
}

/** Las capacidades cuyo resultado cambia con el período. */
function intentNeedsPeriod(intent: AgentIntent): boolean {
  return [
    'sales_summary',
    'units_sold',
    'expenses_summary',
    'business_report',
    'top_products',
    'worst_products',
    'top_customers',
  ].includes(intent);
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
