import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SkillRequestSignatureVerifier,
  TimestampVerifier,
} from 'ask-sdk-express-adapter';
import {
  IntentRequest,
  RequestEnvelope,
  ResponseEnvelope,
} from 'ask-sdk-model';
import { IncomingHttpHeaders } from 'http';
import {
  AssistantScopeService,
  BusinessRef,
  BusinessResolution,
} from '../../assistant/assistant-scope.service';
import { AssistantService } from '../../assistant/assistant.service';
import {
  InventoryStatusAnswer,
  PendingDeliveryAnswer,
  PendingPaymentAnswer,
  PlatformOverviewAnswer,
  SalesTodayAnswer,
} from '../../assistant/assistant.types';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import { AlexaAuthService } from './alexa-auth.service';

const ACTIVATION_SLOT = 'codigo';
const BUSINESS_SLOT = 'negocio';
const ASK_FOR_CODE =
  'Para consultar tus negocios necesito tu código de activación. Di: mi código es, y tu frase.';
const DENIED = 'Esta cuenta de Alexa no está autorizada para usar Lynko.';
const UNCONFIGURED =
  'La autorización por voz de Lynko todavía no está configurada.';

type ActorResult =
  | { status: 'active'; actor: AuthenticatedUser }
  | { status: 'inactive' }
  | { status: 'denied' }
  | { status: 'unconfigured' };

@Injectable()
export class AlexaService {
  private readonly logger = new Logger('Alexa');
  private readonly signatureVerifier = new SkillRequestSignatureVerifier();
  private readonly timestampVerifier = new TimestampVerifier();

  constructor(
    private readonly config: ConfigService,
    private readonly auth: AlexaAuthService,
    private readonly assistant: AssistantService,
    private readonly scope: AssistantScopeService,
  ) {}

  async handleRequest(
    rawBody: Buffer | undefined,
    headers: IncomingHttpHeaders,
  ): Promise<ResponseEnvelope> {
    const skillId = this.config.get<string>('ALEXA_SKILL_ID')?.trim();
    if (!skillId) {
      throw new ServiceUnavailableException(
        'Alexa integration is not configured',
      );
    }

    let envelope: RequestEnvelope;
    try {
      if (!rawBody?.length) throw new Error('Missing raw body');
      const body = rawBody.toString('utf8');
      envelope = JSON.parse(body) as RequestEnvelope;
      // The SDK rejects stale requests; explicitly reject invalid/future dates too.
      const timestamp = envelope?.request?.timestamp;
      if (
        typeof timestamp !== 'string' ||
        !Number.isFinite(Date.parse(timestamp)) ||
        Math.abs(Date.now() - Date.parse(timestamp)) > 150_000
      ) {
        throw new Error('Invalid timestamp');
      }
      await this.timestampVerifier.verify(body);
      await this.signatureVerifier.verify(body, headers);

      const sessionId = envelope.session?.application?.applicationId;
      const contextId = envelope.context?.System?.application?.applicationId;
      if (
        (!sessionId && !contextId) ||
        (sessionId !== undefined && sessionId !== skillId) ||
        (contextId !== undefined && contextId !== skillId) ||
        envelope.version !== '1.0' ||
        typeof envelope.request?.type !== 'string' ||
        (envelope.request.type === 'IntentRequest' &&
          typeof envelope.request.intent?.name !== 'string')
      ) {
        throw new Error('Invalid envelope');
      }
    } catch {
      this.logger.warn('Request verification failed');
      throw new UnauthorizedException('Invalid Alexa request');
    }

    switch (envelope.request.type) {
      case 'LaunchRequest':
        this.logger.log('LaunchRequest received');
        return this.launch(envelope);
      case 'SessionEndedRequest':
        this.logger.log('SessionEndedRequest received');
        return { version: '1.0', response: {} };
      case 'IntentRequest':
        return this.handleIntent(envelope, envelope.request);
      default:
        return this.fallback();
    }
  }

  private async launch(envelope: RequestEnvelope): Promise<ResponseEnvelope> {
    const result = await this.resolveActor(envelope);
    if (result.status !== 'active') return this.reject(result);
    const firstName = result.actor.name?.trim().split(/\s+/)[0];
    return this.speak(
      `Hola${firstName ? ` ${firstName}` : ''}. Lynko está listo. Puedes preguntarme por tus suscripciones.`,
      false,
    );
  }

  private async handleIntent(
    envelope: RequestEnvelope,
    request: IntentRequest,
  ): Promise<ResponseEnvelope> {
    const name = request.intent.name;
    switch (name) {
      case 'ActivarLynkoIntent':
        this.logger.log('IntentRequest: ActivarLynkoIntent');
        return this.activate(envelope, request);
      case 'CerrarAccesoIntent':
        this.logger.log('IntentRequest: CerrarAccesoIntent');
        return this.logout(envelope);
      case 'GetSubscriptionsIntent':
        this.logger.log('IntentRequest: GetSubscriptionsIntent');
        // La sesión queda abierta: encadenar preguntas es lo natural en un
        // asistente de consulta, y reabrir la skill por cada una molesta.
        return this.guarded(envelope, async (actor) =>
          this.speak(
            this.overviewSpeech(await this.assistant.platformOverview(actor)),
            false,
            '¿Quieres preguntar algo más?',
          ),
        );
      case 'pending_payment':
        this.logger.log('IntentRequest: pending_payment');
        return this.forBusiness(envelope, request, async (actor, business) =>
          this.debtSpeech(await this.assistant.pendingPayment(actor, business)),
        );
      case 'list_businesses':
        this.logger.log('IntentRequest: list_businesses');
        return this.guarded(envelope, async (actor) =>
          this.speak(
            this.businessListSpeech(
              await this.scope.accessibleBusinesses(actor),
            ),
            false,
            '¿Quieres preguntar algo más?',
          ),
        );
      case 'sales_summary':
        this.logger.log('IntentRequest: sales_summary');
        return this.forBusiness(envelope, request, async (actor, business) =>
          this.salesSpeech(await this.assistant.salesToday(actor, business)),
        );
      case 'pending_delivery':
        this.logger.log('IntentRequest: pending_delivery');
        return this.forBusiness(envelope, request, async (actor, business) =>
          this.deliverySpeech(
            await this.assistant.pendingDelivery(actor, business),
          ),
        );
      case 'low_stock':
        this.logger.log('IntentRequest: low_stock');
        return this.forBusiness(envelope, request, async (actor, business) =>
          this.lowStockSpeech(
            await this.assistant.inventoryStatus(actor, business),
          ),
        );
      case 'inventory_value':
        this.logger.log('IntentRequest: inventory_value');
        return this.forBusiness(envelope, request, async (actor, business) =>
          this.inventoryValueSpeech(
            await this.assistant.inventoryStatus(actor, business),
          ),
        );
      case 'AMAZON.HelpIntent':
        this.logger.log('IntentRequest: AMAZON.HelpIntent');
        return this.speak(
          'Puedes preguntarme cuántas suscripciones tienes, o por un negocio: cuánto vendí hoy, quién me debe, qué tengo por entregar, qué se está acabando, o cuánto vale mi inventario. Para activar el acceso di: mi código es, y tu frase.',
          false,
        );
      case 'AMAZON.StopIntent':
      case 'AMAZON.CancelIntent':
        this.logger.log(`IntentRequest: ${name}`);
        return this.speak('Hasta luego.', true);
      case 'AMAZON.FallbackIntent':
        // Alexa no encontró intent. Mensaje propio para distinguirlo de un
        // intent que existe en el modelo pero que este switch no maneja.
        this.logger.log('IntentRequest: AMAZON.FallbackIntent');
        return this.speak(
          'No entendí. Para activar el acceso di: mi código es, y luego tu frase.',
          false,
        );
      default:
        // El nombre del intent no es secreto; el valor de los slots sí, y no se registra.
        this.logger.log(`Unhandled intent: ${name}`);
        return this.fallback();
    }
  }

  /** Never logs or echoes the spoken phrase. */
  private async activate(
    envelope: RequestEnvelope,
    request: IntentRequest,
  ): Promise<ResponseEnvelope> {
    const phrase = request.intent.slots?.[ACTIVATION_SLOT]?.value?.trim();
    // Distinto de ASK_FOR_CODE a propósito: al oído hay que poder diferenciar
    // "el slot llegó vacío" de "todavía no me has dicho el código".
    if (!phrase) {
      this.logger.warn('ActivarLynkoIntent without a filled slot');
      return this.speak(
        'No alcancé a escuchar el código. Di: mi código es, y luego tu frase.',
        false,
      );
    }

    let outcome: 'active' | 'invalid' | 'locked';
    try {
      outcome = await this.auth.activate(envelope, phrase);
    } catch (error) {
      return this.reject(this.classify(error));
    }
    this.logger.log(`Activation attempt: ${outcome}`);

    switch (outcome) {
      case 'active': {
        const days = Number(
          this.config.get<string>('ALEXA_AUTH_TTL_DAYS')?.trim() || '7',
        );
        return this.speak(
          `Listo. Tu acceso a Lynko queda activo ${days} días. Puedes preguntarme por tus suscripciones.`,
          false,
        );
      }
      case 'locked':
        return this.speak(
          'Demasiados intentos fallidos. Espera quince minutos antes de volver a intentarlo.',
          true,
        );
      default:
        return this.speak('Ese código no coincide. Inténtalo otra vez.', false);
    }
  }

  private async logout(envelope: RequestEnvelope): Promise<ResponseEnvelope> {
    try {
      await this.auth.logout(envelope);
    } catch (error) {
      return this.reject(this.classify(error));
    }
    return this.speak('Listo. Cerré tu acceso a Lynko.', true);
  }

  private async guarded(
    envelope: RequestEnvelope,
    handler: (
      actor: AuthenticatedUser,
    ) => ResponseEnvelope | Promise<ResponseEnvelope>,
  ): Promise<ResponseEnvelope> {
    const result = await this.resolveActor(envelope);
    if (result.status !== 'active') return this.reject(result);
    try {
      return await handler(result.actor);
    } catch (error) {
      // Permiso insuficiente del usuario Lynko: distinto de "cuenta de Alexa
      // no autorizada", que se resuelve en resolveActor.
      if (error instanceof ForbiddenException) {
        this.logger.warn('Query denied: insufficient Lynko permissions');
        return this.speak(
          'Tu usuario no tiene permiso para esa consulta.',
          true,
        );
      }
      // Consulta de retail sobre un negocio de otra vertical: los servicios
      // lanzan BadRequest desde `assertRetailTenant`. Sin esto sería un 500 y
      // Alexa diría su error genérico, que no explica nada.
      if (error instanceof BadRequestException) {
        this.logger.warn('Query not applicable to this tenant vertical');
        return this.speak(
          'Esa consulta es de tiendas, y ese negocio no lo es.',
          false,
        );
      }
      throw error;
    }
  }

  /**
   * Consulta acotada a un negocio: resuelve el ámbito, y si no se puede,
   * repregunta en vez de responder por el negocio equivocado.
   */
  private forBusiness(
    envelope: RequestEnvelope,
    request: IntentRequest,
    answer: (
      actor: AuthenticatedUser,
      business: BusinessRef,
    ) => Promise<string>,
  ): Promise<ResponseEnvelope> {
    return this.guarded(envelope, async (actor) => {
      const spoken = request.intent.slots?.[BUSINESS_SLOT]?.value;
      const resolution = await this.scope.resolveBusiness(actor, spoken);
      if (resolution.status !== 'resolved') {
        return this.speak(this.businessPrompt(resolution), false);
      }
      return this.speak(
        await answer(actor, resolution.business),
        false,
        '¿Quieres preguntar algo más?',
      );
    });
  }

  private salesSpeech(answer: SalesTodayAnswer): string {
    const { business, salesCount, revenueCOP } = answer;
    if (!salesCount) {
      return `Hoy todavía no hay ventas en ${business.name}.`;
    }
    const head = `Hoy en ${business.name} llevas ${revenueCOP} pesos en ${
      salesCount === 1 ? '1 venta' : `${salesCount} ventas`
    }, con un ticket promedio de ${answer.averageTicketCOP} pesos.`;
    // La deuda que dejó el día es distinta de la cartera total: esa es
    // pending_payment. Decirlo acá evita que suene al mismo número.
    return answer.pendingTodayCOP
      ? `${head} De eso, ${answer.pendingTodayCOP} pesos quedaron fiados hoy.`
      : head;
  }

  private deliverySpeech(answer: PendingDeliveryAnswer): string {
    const { business, salesCount, customers } = answer;
    if (!salesCount) {
      return `En ${business.name} no tienes entregas pendientes.`;
    }
    const head = `En ${business.name} tienes ${
      salesCount === 1 ? '1 venta' : `${salesCount} ventas`
    } por entregar, por ${answer.totalCOP} pesos.`;
    const top = customers.slice(0, 3).map((c) => c.name);
    const rest = customers.length - top.length;
    return `${head} ${top.join(', ')}${
      rest > 0
        ? ` y ${rest} ${rest === 1 ? 'cliente más' : 'clientes más'}`
        : ''
    }.`;
  }

  private lowStockSpeech(answer: InventoryStatusAnswer): string {
    const { business, lowStock, outOfStockCount } = answer;
    if (!lowStock.length) {
      return `En ${business.name} ningún producto está por debajo del mínimo.`;
    }
    const head = `En ${business.name} hay ${lowStock.length} ${
      lowStock.length === 1 ? 'producto bajo' : 'productos bajos'
    } de stock${outOfStockCount ? `, ${outOfStockCount} de ellos agotados` : ''}.`;
    // Tres nombres como mucho: por voz, una lista larga no se retiene.
    const worst = lowStock
      .slice(0, 3)
      .map((p) => `${p.name}, ${p.stock === 0 ? 'agotado' : `${p.stock}`}`);
    return `${head} Los más bajos: ${worst.join('; ')}.`;
  }

  private inventoryValueSpeech(answer: InventoryStatusAnswer): string {
    const { business, totalUnits, trackedProducts } = answer;
    if (!trackedProducts) {
      return `En ${business.name} no hay productos con control de stock.`;
    }
    // Al costo, no al precio de venta: es la plata que está quieta en la bodega.
    return `En ${business.name} tienes ${totalUnits} unidades en ${trackedProducts} productos, por ${answer.valueAtCostCOP} pesos al costo.`;
  }

  /**
   * Repregunta sin enumerar.
   *
   * Con una decena de negocios, recitarlos todos en cada repregunta es peor que
   * no responder: el listado va en su propio intent, cuando lo piden. Solo se
   * nombran los candidatos de una ambigüedad, que son dos o tres.
   */
  private businessPrompt(
    resolution: Exclude<BusinessResolution, { status: 'resolved' }>,
  ): string {
    if (resolution.status === 'ambiguous') {
      return `¿Te refieres a ${resolution.matches.map((b) => b.name).join(' o a ')}?`;
    }
    if (!resolution.available.length) {
      return 'Tu usuario no tiene negocios asignados.';
    }
    return resolution.status === 'missing'
      ? '¿De cuál negocio?'
      : 'No reconozco ese negocio. Puedes decir: lista mis negocios.';
  }

  private businessListSpeech(businesses: BusinessRef[]): string {
    if (!businesses.length) return 'Tu usuario no tiene negocios asignados.';
    const names = businesses.map((b) => b.name).join(', ');
    return `Tienes ${businesses.length === 1 ? '1 negocio' : `${businesses.length} negocios`}: ${names}.`;
  }

  /** Nombra a los dos que más deben: por voz, una lista larga no se retiene. */
  private debtSpeech(answer: PendingPaymentAnswer): string {
    const { business, customers, unidentified } = answer;
    if (answer.totalCOP === 0) {
      return `En ${business.name} no te deben nada. Todas las ventas están cobradas.`;
    }

    const head = `En ${business.name} te deben ${answer.totalCOP} pesos en ${
      answer.salesCount === 1 ? '1 venta' : `${answer.salesCount} ventas`
    }.`;

    const top = customers
      .slice(0, 2)
      .map((c) => `${c.name}, ${c.amountCOP} pesos`);
    const rest = customers.length - top.length;
    const detail = top.length
      ? ` ${top.length === 1 ? 'Debe' : 'Deben'} ${top.join(' y ')}${
          rest > 0
            ? `, y ${rest} ${rest === 1 ? 'cliente más' : 'clientes más'}`
            : ''
        }.`
      : '';

    // Sin cliente asociado no hay a quién llamar: decirlo evita que el total
    // parezca no cuadrar con los nombres.
    const counter = unidentified.amountCOP
      ? ` Hay ${unidentified.amountCOP} pesos en ventas de mostrador sin cliente registrado.`
      : '';

    return `${head}${detail}${counter}`;
  }

  /** Dos frases como mucho: por voz, un listado largo no se retiene. */
  private overviewSpeech(answer: PlatformOverviewAnswer): string {
    const { subscriptions: subs, tenants } = answer;
    const plural = (n: number, one: string, many: string) =>
      `${n} ${n === 1 ? one : many}`;

    const detail = [
      subs.trialing ? `${subs.trialing} en prueba` : null,
      subs.pastDue ? `${subs.pastDue} en mora` : null,
    ].filter(Boolean);

    const first = `Tienes ${plural(subs.active, 'suscripción activa', 'suscripciones activas')}${
      detail.length ? `, ${detail.join(' y ')}` : ''
    }, sobre ${plural(tenants.total, 'negocio', 'negocios')} en total.`;

    // Pagos cobrados, no MRR. El MRR suma el precio de lista de toda suscripción
    // activa, incluidas las que nunca pagaron —descuento del 100%, cortesías, el
    // tenant propio—, así que por voz suena a ingreso y no lo es. `amount` de
    // SubscriptionPayment es plata recibida neta, y los bonos quedan fuera por
    // `countsAsRevenue`. Sin separadores de miles: Alexa lee mejor el número crudo.
    const { count, totalCOP } = answer.payments;
    const second = count
      ? `Este mes has recibido ${plural(count, 'pago', 'pagos')} por ${totalCOP} pesos.`
      : 'Este mes todavía no has recibido pagos.';

    return `${first} ${second}`;
  }

  private async resolveActor(envelope: RequestEnvelope): Promise<ActorResult> {
    try {
      const actor = await this.auth.actor(envelope);
      return actor ? { status: 'active', actor } : { status: 'inactive' };
    } catch (error) {
      return this.classify(error);
    }
  }

  private classify(error: unknown): ActorResult {
    if (error instanceof ServiceUnavailableException) {
      this.logger.warn('Voice authorization is not configured');
      return { status: 'unconfigured' };
    }
    if (error instanceof ForbiddenException) {
      this.logger.warn('Voice authorization denied');
      return { status: 'denied' };
    }
    throw error;
  }

  private reject(result: ActorResult): ResponseEnvelope {
    switch (result.status) {
      case 'unconfigured':
        return this.speak(UNCONFIGURED, true);
      case 'denied':
        return this.speak(DENIED, true);
      default:
        return this.speak(ASK_FOR_CODE, false, ASK_FOR_CODE);
    }
  }

  private fallback(): ResponseEnvelope {
    return this.speak(
      'No pude reconocer esa consulta. Por ahora puedes preguntarme por tus suscripciones.',
      false,
    );
  }

  private speak(
    text: string,
    shouldEndSession: boolean,
    reprompt = 'Puedes preguntarme cuántas suscripciones tienes.',
  ): ResponseEnvelope {
    return {
      version: '1.0',
      response: {
        outputSpeech: { type: 'PlainText', text },
        shouldEndSession,
        ...(!shouldEndSession && {
          reprompt: {
            outputSpeech: { type: 'PlainText', text: reprompt },
          },
        }),
      },
    };
  }
}
