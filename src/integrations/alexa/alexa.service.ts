import { AsyncLocalStorage } from 'node:async_hooks';
import { AssistantOutcome } from '@prisma/client';
import { AssistantTelemetryService } from '../../assistant/telemetry/telemetry.service';
import { safeIntent } from '../../assistant/telemetry/telemetry.dto';
import { TelemetryAlexaSkill } from './alexa-skill.repository';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AlexaSkill } from '@prisma/client';
import {
  SkillRequestSignatureVerifier,
  TimestampVerifier,
} from 'ask-sdk-express-adapter';
import {
  Directive,
  IntentRequest,
  RequestEnvelope,
  ResponseEnvelope,
  ui,
} from 'ask-sdk-model';
import { IncomingHttpHeaders } from 'http';
import {
  AssistantScopeService,
  BusinessRef,
  BusinessResolution,
} from '../../assistant/assistant-scope.service';
import { AssistantService } from '../../assistant/assistant.service';
import {
  BusinessReportAnswer,
  ReportPeriod,
  CatalogCategoryAnswer,
  CatalogOverviewAnswer,
  ExpensesAnswer,
  InventoryStatusAnswer,
  PendingDeliveryAnswer,
  PendingPaymentAnswer,
  PendingPurchaseAnswer,
  PlatformOverviewAnswer,
  ProductLookupAnswer,
  SalesAnswer,
  SalesRankingAnswer,
} from '../../assistant/assistant.types';
import { periodLabel, parsePeriod } from '../../assistant/report-period';
import { formatCOP } from '../../common/date.util';

import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import { AlexaAuthService } from './alexa-auth.service';
import { AlexaSkillRepository } from './alexa-skill.repository';
import { debtDocument, reportDocument, salesDocument } from './apl/report.apl';
/**
 * Plata dicha en voz alta.
 *
 * Sin separadores de miles ni símbolo: Alexa lee mejor "450000 pesos" que
 * "$450.000", que pronuncia como una cadena de puntos. `formatCOP` se reserva
 * para las tarjetas y la pantalla, donde sí se LEE.
 */
const speakCOP = (amount: number): string => `${amount} pesos`;

/**
 * Lo que un intent puede devolver: la frase hablada y, cuando hay pantalla,
 * la tarjeta y el documento APL que la acompañan.
 */
interface SpokenAnswer {
  speech: string;
  card?: ui.Card;
  directives?: Directive[];
}

const ACTIVATION_SLOT = 'codigo';
const BUSINESS_SLOT = 'negocio';
const PERIOD_SLOT = 'periodo';
const CATEGORY_SLOT = 'categoria';
const PRODUCT_SLOT = 'producto';
/** Por voz no se retienen más de tres nombres seguidos. */
const MAX_NAMES = 3;
const ASK_FOR_CODE =
  'Para consultar tus negocios necesito tu código de activación. Di: mi código es, y tu frase.';
const DENIED = 'Esta cuenta de Alexa no está autorizada para usar Lynko.';
const UNCONFIGURED =
  'La autorización por voz de Lynko todavía no está configurada.';
const DETAIL_HINT =
  'Para el detalle di: quién me debe, en qué se me va la plata, qué se está acabando, o qué tengo por recibir.';

type ActorResult =
  | { status: 'active'; actor: AuthenticatedUser }
  | { status: 'inactive' }
  | { status: 'denied' }
  | { status: 'unconfigured' };

@Injectable()
export class AlexaService {
  private readonly observation = new AsyncLocalStorage<{
    tenantId: string;
    vertical: string;
    roleCode: string;
    outcome: AssistantOutcome;
  }>();
  private readonly logger = new Logger('Alexa');
  private readonly signatureVerifier = new SkillRequestSignatureVerifier();
  private readonly timestampVerifier = new TimestampVerifier();

  constructor(
    private readonly skills: AlexaSkillRepository,
    private readonly auth: AlexaAuthService,
    private readonly assistant: AssistantService,
    private readonly scope: AssistantScopeService,
    @Optional() private readonly telemetry?: AssistantTelemetryService,
  ) {}

  async handleRequest(
    rawBody: Buffer | undefined,
    headers: IncomingHttpHeaders,
  ): Promise<ResponseEnvelope> {
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
        // Las dos copias del id tienen que coincidir entre sí: una petición que
        // diga una skill en la sesión y otra en el contexto está manipulada.
        (sessionId !== undefined &&
          contextId !== undefined &&
          sessionId !== contextId) ||
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

    // Qué negocio es lo decide el applicationId que Amazon firmó, no algo que
    // alguien haya pronunciado. Una skill sin registrar se rechaza como antes
    // lo hacía un ALEXA_SKILL_ID distinto.
    const applicationId =
      envelope.context?.System?.application?.applicationId ??
      envelope.session?.application?.applicationId ??
      '';
    const skill = await this.skills.byApplicationId(applicationId);
    if (!skill) {
      this.logger.warn('Request from an unregistered skill');
      throw new UnauthorizedException('Invalid Alexa request');
    }

    switch (envelope.request.type) {
      case 'LaunchRequest':
        this.logger.log('LaunchRequest received');
        return this.launch(envelope, skill);
      case 'SessionEndedRequest':
        this.logger.log('SessionEndedRequest received');
        return { version: '1.0', response: {} };
      case 'IntentRequest':
        return this.observedIntent(envelope, skill, envelope.request);
      default:
        return this.fallback(envelope);
    }
  }

  private observedIntent(
    envelope: RequestEnvelope,
    skill: TelemetryAlexaSkill,
    request: IntentRequest,
  ): Promise<ResponseEnvelope> {
    const started = Date.now();
    const fallback =
      request.intent.name === 'AMAZON.FallbackIntent' ||
      safeIntent(request.intent.name) === 'unknown';
    const state: {
      tenantId: string;
      vertical: string;
      roleCode: string;
      outcome: AssistantOutcome;
    } = {
      tenantId: skill.tenantId ?? '',
      vertical: skill.tenant?.vertical?.code ?? '',
      roleCode: skill.actingUser?.role.code ?? 'OTHER',
      outcome: fallback ? AssistantOutcome.FALLBACK : AssistantOutcome.ANSWERED,
    };
    return this.observation.run(state, async () => {
      try {
        return await this.handleIntent(envelope, skill, request);
      } catch (error) {
        state.outcome = 'ERROR';
        throw error;
      } finally {
        // Exactly one emission point. Slots, Alexa IDs, and spoken text never leave this handler.
        try {
          const scoped = [
            'sales_summary',
            'business_report',
            'top_products',
            'worst_products',
            'top_customers',
          ].includes(request.intent.name);
          const period = scoped
            ? parsePeriod(this.slotValue(request, PERIOD_SLOT))
            : null;
          this.telemetry?.record(
            state,
            [
              {
                vertical: state.vertical,
                intentId: fallback ? 'fallback' : request.intent.name,
                outcome: state.outcome,
                confidence: fallback ? 'LOW' : 'HIGH',
                level: 'READ',
                scope: period === 'day' ? 'today' : period,
                resolvedTo: null,
                latencyMs: Date.now() - started,
              },
            ],
            'ALEXA',
          );
        } catch {
          /* Never delay or break voice responses. */
        }
      }
    });
  }

  private outcome(outcome: AssistantOutcome): void {
    const state = this.observation.getStore();
    if (state) state.outcome = outcome;
  }

  private async launch(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
  ): Promise<ResponseEnvelope> {
    const result = await this.resolveActor(envelope, skill);
    if (result.status !== 'active') {
      this.outcome('DENIED_PERMISSION');
      return this.reject(result);
    }
    const firstName = result.actor.name?.trim().split(/\s+/)[0];
    return this.speak(
      `Hola${firstName ? ` ${firstName}` : ''}. Lynko está listo. Puedes preguntarme por tus suscripciones.`,
      false,
    );
  }

  private async handleIntent(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
    request: IntentRequest,
  ): Promise<ResponseEnvelope> {
    const name = request.intent.name;
    switch (name) {
      case 'ActivarLynkoIntent':
        this.logger.log('IntentRequest: ActivarLynkoIntent');
        return this.activate(envelope, skill, request);
      case 'CerrarAccesoIntent':
        this.logger.log('IntentRequest: CerrarAccesoIntent');
        return this.logout(envelope, skill);
      case 'GetSubscriptionsIntent':
        this.logger.log('IntentRequest: GetSubscriptionsIntent');
        // La sesión queda abierta: encadenar preguntas es lo natural en un
        // asistente de consulta, y reabrir la skill por cada una molesta.
        return this.guarded(envelope, skill, async (actor) =>
          this.speak(
            this.overviewSpeech(await this.assistant.platformOverview(actor)),
            false,
            '¿Quieres preguntar algo más?',
          ),
        );
      case 'pending_payment':
        this.logger.log('IntentRequest: pending_payment');
        return this.forBusiness(
          envelope,
          skill,
          request,
          async (actor, business) => {
            const debt = await this.assistant.pendingPayment(actor, business);
            return {
              speech: this.debtSpeech(debt),
              card: this.debtCard(debt),
              directives: this.supportsApl(envelope)
                ? [debtDocument(debt)]
                : undefined,
            };
          },
        );
      case 'list_businesses':
        this.logger.log('IntentRequest: list_businesses');
        return this.guarded(envelope, skill, async (actor) =>
          this.speak(
            this.businessListSpeech(
              await this.scope.accessibleBusinesses(actor),
            ),
            false,
            '¿Quieres preguntar algo más?',
          ),
        );
      case 'business_report':
        this.logger.log('IntentRequest: business_report');
        return this.forBusiness(
          envelope,
          skill,
          request,
          async (actor, business) => {
            const period = parsePeriod(this.slotValue(request, PERIOD_SLOT));
            const report = await this.assistant.businessReport(
              actor,
              business,
              period,
            );
            return {
              speech: this.reportSpeech(report),
              // La tarjeta se manda siempre: es lo que queda en el historial
              // de la app, y es todo lo que ve un Echo sin pantalla.
              card: this.reportCard(report),
              directives: this.supportsApl(envelope)
                ? [reportDocument(report)]
                : undefined,
            };
          },
        );
      case 'sales_summary':
        this.logger.log('IntentRequest: sales_summary');
        return this.forBusiness(
          envelope,
          skill,
          request,
          async (actor, business) => {
            const sales = await this.assistant.sales(
              actor,
              business,
              parsePeriod(this.slotValue(request, PERIOD_SLOT)),
            );
            return {
              speech: this.salesSpeech(sales),
              card: this.salesCard(sales),
              directives: this.supportsApl(envelope)
                ? [salesDocument(sales)]
                : undefined,
            };
          },
        );
      case 'units_sold':
        this.logger.log('IntentRequest: units_sold');
        return this.forBusiness(envelope, skill, request, async (a, b) =>
          this.unitsSoldSpeech(
            await this.assistant.sales(
              a,
              b,
              // Unidades con un solo día de datos no dicen nada: el default es
              // el mes, y la frase lo nombra para que nadie lo dé por otro.
              this.periodOf(request, 'month'),
            ),
          ),
        );
      case 'expenses_summary':
        this.logger.log('IntentRequest: expenses_summary');
        return this.forBusiness(envelope, skill, request, async (a, b) =>
          this.expensesSpeech(
            await this.assistant.expenses(a, b, this.periodOf(request, 'month')),
          ),
        );
      case 'pending_delivery':
        this.logger.log('IntentRequest: pending_delivery');
        return this.forBusiness(
          envelope,
          skill,
          request,
          async (actor, business) =>
            this.deliverySpeech(
              await this.assistant.pendingDelivery(actor, business),
            ),
        );
      case 'pending_purchase':
        this.logger.log('IntentRequest: pending_purchase');
        return this.forBusiness(envelope, skill, request, async (a, b) =>
          this.purchaseSpeech(await this.assistant.pendingPurchase(a, b)),
        );
      case 'top_products':
      case 'worst_products':
      case 'top_customers':
        this.logger.log(`IntentRequest: ${name}`);
        return this.forBusiness(envelope, skill, request, async (a, b) =>
          this.rankingSpeech(
            await this.assistant.salesRanking(
              a,
              b,
              parsePeriod(this.slotValue(request, PERIOD_SLOT)),
            ),
            name,
          ),
        );
      case 'catalog_overview':
        this.logger.log('IntentRequest: catalog_overview');
        return this.forBusiness(envelope, skill, request, async (a, b) =>
          this.catalogSpeech(await this.assistant.catalogOverview(a, b)),
        );
      case 'catalog_category':
        this.logger.log('IntentRequest: catalog_category');
        return this.forBusiness(envelope, skill, request, async (a, b) => {
          const spoken = this.slotValue(request, CATEGORY_SLOT);
          if (!spoken) {
            this.outcome('CLARIFIED');
            return '¿De cuál categoría?';
          }
          return this.categorySpeech(
            await this.assistant.catalogCategory(a, b, spoken),
            spoken,
          );
        });
      case 'product_lookup':
        this.logger.log('IntentRequest: product_lookup');
        return this.forBusiness(envelope, skill, request, async (a, b) => {
          const spoken = this.slotValue(request, PRODUCT_SLOT);
          if (!spoken) {
            this.outcome('CLARIFIED');
            return '¿De cuál producto?';
          }
          return this.productSpeech(
            await this.assistant.productLookup(a, b, spoken),
            spoken,
          );
        });
      case 'low_stock':
        this.logger.log('IntentRequest: low_stock');
        return this.forBusiness(
          envelope,
          skill,
          request,
          async (actor, business) =>
            this.lowStockSpeech(
              await this.assistant.inventoryStatus(actor, business),
            ),
        );
      case 'out_of_stock':
        this.logger.log('IntentRequest: out_of_stock');
        return this.forBusiness(
          envelope,
          skill,
          request,
          async (actor, business) =>
            this.outOfStockSpeech(
              await this.assistant.inventoryStatus(actor, business),
            ),
        );
      case 'inventory_value':
        this.logger.log('IntentRequest: inventory_value');
        return this.forBusiness(
          envelope,
          skill,
          request,
          async (actor, business) =>
            this.inventoryValueSpeech(
              await this.assistant.inventoryStatus(actor, business),
            ),
        );
      case 'AMAZON.HelpIntent':
        this.logger.log('IntentRequest: AMAZON.HelpIntent');
        return this.speak(
          // Se nombran siete de las catorce: una lista hablada más larga no se
          // retiene, y estas cubren las cuatro áreas —entra, sale, mercancía,
          // clientes— para que se entienda el alcance sin enumerarlo entero.
          'Puedes preguntarme por un negocio: cuánto vendí hoy, cuántas unidades vendí este mes, en qué se me va la plata, quién me debe, qué tengo por entregar, qué pedidos faltan por recibir, o qué se está acabando. También puedes pedirme un período: el mes pasado, o los últimos quince días. Para activar el acceso di: mi código es, y tu frase.',
          false,
        );
      case 'AMAZON.YesIntent':
        // Un sí suelto no dice a qué: se repiten las opciones en vez de
        // adivinar, que es lo que hacía caer todo en el reporte otra vez.
        this.logger.log('IntentRequest: AMAZON.YesIntent');
        return this.speak(DETAIL_HINT, false, DETAIL_HINT);
      case 'AMAZON.NoIntent':
        this.logger.log('IntentRequest: AMAZON.NoIntent');
        return this.speak('Listo. Aquí estoy si necesitas algo más.', false);
      case 'AMAZON.NavigateHomeIntent':
        // Con APL encendido este intent llega de verdad, al tocar "inicio" en
        // la pantalla. Caía en `default`, y responder "no entendí" a una
        // navegación es de las cosas que anota certificación.
        this.logger.log('IntentRequest: AMAZON.NavigateHomeIntent');
        return this.speak(DETAIL_HINT, false, DETAIL_HINT);
      case 'DespedidaIntent':
        // Separado de Stop a propósito: quien agradece no está cancelando algo,
        // y "Hasta luego" a secas suena a que le colgaron.
        this.logger.log('IntentRequest: DespedidaIntent');
        return this.speak('Con gusto. Hasta luego.', true);
      case 'AMAZON.StopIntent':
      case 'AMAZON.CancelIntent':
        this.logger.log(`IntentRequest: ${name}`);
        return this.speak('Hasta luego.', true);
      case 'AMAZON.FallbackIntent':
        // Alexa no encontró intent. Mensaje propio para distinguirlo de un
        // intent que existe en el modelo pero que este switch no maneja.
        this.logger.log('IntentRequest: AMAZON.FallbackIntent');
        return this.fallback(envelope);
      default:
        // El nombre del intent no es secreto; el valor de los slots sí, y no se registra.
        this.logger.log(`Unhandled intent: ${name}`);
        return this.fallback(envelope);
    }
  }

  /** Never logs or echoes the spoken phrase. */
  private async activate(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
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
      outcome = await this.auth.activate(envelope, skill, phrase);
    } catch (error) {
      return this.reject(this.classify(error));
    }
    this.logger.log(`Activation attempt: ${outcome}`);

    switch (outcome) {
      case 'active':
        return this.speak(
          `Listo. Tu acceso a Lynko queda activo ${skill.ttlDays} días. Puedes preguntarme por tus suscripciones.`,
          false,
        );
      case 'locked':
        return this.speak(
          'Demasiados intentos fallidos. Espera quince minutos antes de volver a intentarlo.',
          true,
        );
      default:
        return this.speak('Ese código no coincide. Inténtalo otra vez.', false);
    }
  }

  private async logout(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
  ): Promise<ResponseEnvelope> {
    try {
      await this.auth.logout(envelope, skill);
    } catch (error) {
      return this.reject(this.classify(error));
    }
    return this.speak('Listo. Cerré tu acceso a Lynko.', true);
  }

  private async guarded(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
    handler: (
      actor: AuthenticatedUser,
    ) => ResponseEnvelope | Promise<ResponseEnvelope>,
  ): Promise<ResponseEnvelope> {
    const result = await this.resolveActor(envelope, skill);
    if (result.status !== 'active') {
      this.outcome('DENIED_PERMISSION');
      return this.reject(result);
    }
    try {
      return await handler(result.actor);
    } catch (error) {
      // Permiso insuficiente del usuario Lynko: distinto de "cuenta de Alexa
      // no autorizada", que se resuelve en resolveActor.
      if (error instanceof ForbiddenException) {
        this.outcome('DENIED_PERMISSION');
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
        this.outcome('ERROR');
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
    skill: AlexaSkill,
    request: IntentRequest,
    answer: (
      actor: AuthenticatedUser,
      business: BusinessRef,
    ) => Promise<string | SpokenAnswer>,
  ): Promise<ResponseEnvelope> {
    return this.guarded(envelope, skill, async (actor) => {
      const spoken = this.slotValue(request, BUSINESS_SLOT);
      // El negocio de la pregunta anterior: sin esto, encadenar "dame el
      // reporte de Bella Chic" con "quién me debe" obligaría a repetir el
      // nombre en cada frase.
      const remembered = this.rememberedBusinessId(envelope);
      const resolution = await this.scope.resolveBusiness(
        actor,
        spoken,
        remembered,
      );
      if (resolution.status !== 'resolved') {
        this.outcome('CLARIFIED');
        return this.speak(this.businessPrompt(resolution), false);
      }
      const state = this.observation.getStore();
      if (state) {
        state.tenantId = resolution.business.id;
        state.vertical = resolution.business.vertical?.code ?? state.vertical;
      }
      const result = await answer(actor, resolution.business);
      const { speech, card, directives } =
        typeof result === 'string'
          ? { speech: result, card: undefined, directives: undefined }
          : result;
      return this.speak(
        speech,
        false,
        '¿Quieres preguntar algo más?',
        card,
        { businessId: resolution.business.id },
        directives,
      );
    });
  }

  private rememberedBusinessId(envelope: RequestEnvelope): string | undefined {
    // `attributes` es lo que devolvimos nosotros, pero viaja por Alexa: se
    // trata como dato externo y se valida igual contra los negocios del actor.
    const attributes = envelope.session?.attributes as
      | Record<string, unknown>
      | undefined;
    const value = attributes?.['businessId'];
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * Los cinco bloques en cifras, sin nombres.
   *
   * Por voz no se retienen nueve deudores: el resumen da los números y ofrece
   * el detalle, que resuelven los intents que ya existen. En un dispositivo con
   * pantalla, la tarjeta muestra lo que la voz no puede.
   */
  /**
   * "hay" para hoy, "hubo" para ayer.
   *
   * `ayer` es el único período cerrado del modelo: "no hay ventas ayer" está
   * mal dicho, y en un asistente de voz la frase es el producto.
   */
  private existed(period: ReportPeriod): string {
    return period === 'yesterday' ? 'hubo' : 'hay';
  }

  private reportSpeech(report: BusinessReportAnswer): string {
    const { business, sales, debt, inventory, purchases, delivery } = report;
    const when = periodLabel(report.period);

    const first = sales.salesCount
      ? `${this.capitalize(when)} vendiste ${sales.revenueCOP} pesos en ${sales.salesCount === 1 ? '1 venta' : `${sales.salesCount} ventas`}.`
      : `No ${this.existed(report.period)} ventas ${when}.`;

    // La cartera, el stock y los pendientes NO se acotan al período: son una
    // foto de hoy. Decirlos con "esta semana" sería inventar la cifra.
    const parts = [`Reporte de ${business.name}.`, first];

    if (debt.totalCOP) {
      const people = debt.customers.length;
      parts.push(
        `Te deben ${debt.totalCOP} pesos en total${people ? `, de ${people === 1 ? '1 cliente' : `${people} clientes`}` : ''}.`,
      );
    } else {
      parts.push('No te deben nada.');
    }

    if (inventory.lowStockCount) {
      parts.push(
        `Hay ${inventory.lowStockCount === 1 ? '1 producto bajo' : `${inventory.lowStockCount} productos bajos`} de stock${inventory.outOfStockCount ? `, ${inventory.outOfStockCount} agotados` : ''}.`,
      );
    }
    if (purchases.openCount) {
      parts.push(
        `Tienes ${purchases.openCount === 1 ? '1 pedido abierto' : `${purchases.openCount} pedidos abiertos`} con el proveedor.`,
      );
    }
    if (delivery.salesCount) {
      parts.push(
        `Y ${delivery.salesCount === 1 ? '1 venta' : `${delivery.salesCount} ventas`} por entregar.`,
      );
    }

    // No se pregunta "¿quieres el detalle?": un sí no dice de cuál, y obliga a
    // otra repregunta. Se nombran las frases exactas, que además son los
    // intents que ya existen.
    parts.push(DETAIL_HINT);
    return parts.join(' ');
  }

  /** Lo que la voz no puede dar: los nombres. Solo se ve si hay pantalla. */
  private reportCard(report: BusinessReportAnswer): ui.Card {
    const { sales, debt, inventory, purchases, delivery } = report;
    const names = (list: { name: string }[], extra: (i: number) => string) =>
      list
        .slice(0, 5)
        .map((item, i) => `  • ${item.name}${extra(i)}`)
        .join('\n');

    const lines = [
      `Ventas (${periodLabel(report.period)}): ${sales.revenueCOP} en ${sales.salesCount} ventas`,
      `Ticket promedio: ${sales.averageTicketCOP} · Margen: ${sales.marginPct}%`,
      '',
      `Por cobrar: ${debt.totalCOP} en ${debt.salesCount} ventas`,
      names(debt.customers, (i) => `: ${debt.customers[i].amountCOP}`),
      debt.unidentified.amountCOP
        ? `  • Sin cliente: ${debt.unidentified.amountCOP}`
        : '',
      '',
      `Stock bajo: ${inventory.lowStockCount} (${inventory.outOfStockCount} agotados)`,
      names(inventory.lowStock, (i) => `: ${inventory.lowStock[i].stock}`),
      '',
      `Pedidos abiertos: ${purchases.openCount} · ${purchases.estimatedOpenCostCOP} estimados`,
      `Por entregar: ${delivery.salesCount} ventas · ${delivery.totalCOP}`,
      names(delivery.customers, (i) => `: ${delivery.customers[i].totalCOP}`),
    ];

    return {
      type: 'Simple',
      title: `Reporte · ${report.business.name}`,
      content: lines.filter((line) => line !== '').join('\n'),
    };
  }

  /**
   * La cartera en la tarjeta.
   *
   * En el teléfono la tarjeta es lo único que hay —la app de Alexa no pinta
   * APL—, así que acá van los nombres y los montos con separadores: es la
   * pantalla donde de verdad se leen.
   */
  private debtCard(answer: PendingPaymentAnswer): ui.Card {
    const lines = [
      `Por cobrar: ${formatCOP(answer.totalCOP)} en ${answer.salesCount} ${answer.salesCount === 1 ? 'venta' : 'ventas'}`,
      '',
      ...answer.customers
        .slice(0, 8)
        .map((c) => `  • ${c.name}: ${formatCOP(c.amountCOP)}`),
      answer.unidentified.amountCOP
        ? `  • Sin cliente: ${formatCOP(answer.unidentified.amountCOP)}`
        : '',
    ];
    return {
      type: 'Simple',
      title: `Por cobrar · ${answer.business.name}`,
      content: lines.filter((line) => line !== '').join('\n'),
    };
  }

  private salesCard(answer: SalesAnswer): ui.Card {
    const lines = [
      `Ventas (${periodLabel(answer.period)}): ${formatCOP(answer.revenueCOP)} en ${answer.salesCount} ${answer.salesCount === 1 ? 'venta' : 'ventas'}`,
      `Ticket promedio: ${formatCOP(answer.averageTicketCOP)} · Margen: ${answer.marginPct}%`,
      `Unidades: ${answer.unitsSold}`,
      answer.creditedCOP ? `Fiado: ${formatCOP(answer.creditedCOP)}` : '',
      // El flete no está dentro de `revenueCOP`: nombrarlo aparte evita que
      // alguien sume dos cifras que ya no se suman.
      answer.shippingCOP
        ? `Flete aparte: ${formatCOP(answer.shippingCOP)}`
        : '',
    ];
    return {
      type: 'Simple',
      title: `Ventas · ${answer.business.name}`,
      content: lines.filter((line) => line !== '').join('\n'),
    };
  }

  /**
   * El período del slot, con un default por capacidad.
   *
   * `parsePeriod` asume el día cuando no viene slot, y para ventas está bien
   * —"cuánto vendí" es una pregunta sobre hoy—, pero para gastos o unidades un
   * solo día no responde nada. La frase hablada siempre nombra el rango que se
   * usó, así que asumir no es el problema: asumir en silencio, sí.
   */
  private periodOf(request: IntentRequest, fallback: ReportPeriod) {
    const spoken = this.slotValue(request, PERIOD_SLOT);
    return spoken ? parsePeriod(spoken) : fallback;
  }

  /** Unidades, no pesos. Se nombran las dos cifras porque la siguiente pregunta siempre es esa. */
  private unitsSoldSpeech(answer: SalesAnswer): string {
    if (!answer.unitsSold) this.outcome('NO_DATA');
    const when = periodLabel(answer.period);
    if (!answer.unitsSold) {
      return `En ${answer.business.name} no se vendió ninguna unidad ${when}.`;
    }
    const units =
      answer.unitsSold === 1 ? '1 unidad' : `${answer.unitsSold} unidades`;
    return `${when.charAt(0).toUpperCase()}${when.slice(1)} en ${answer.business.name} se ${answer.unitsSold === 1 ? 'vendió' : 'vendieron'} ${units}, por ${speakCOP(answer.revenueCOP)}.`;
  }

  private expensesSpeech(answer: ExpensesAnswer): string {
    if (!answer.totalCOP) this.outcome('NO_DATA');
    const when = periodLabel(answer.period);
    if (!answer.totalCOP) {
      return `En ${answer.business.name} no hay gastos registrados ${when}.`;
    }
    // Por voz, dos categorías. Una lista de nueve no se retiene y lo que se
    // busca es saber por dónde se va la plata, no el detalle contable.
    const top = answer.byCategory
      .slice(0, 2)
      .map((row) => `${row.category}, ${speakCOP(row.amountCOP)}`)
      .join('; y ');
    return `En ${answer.business.name} los gastos ${when} suman ${speakCOP(answer.totalCOP)}${top ? `. Lo más alto: ${top}` : ''}.`;
  }

  /** Lo que falta RECIBIR del proveedor: se dice explícito para no confundirlo con lo que falta entregar. */
  private purchaseSpeech(answer: PendingPurchaseAnswer): string {
    if (!answer.openCount) this.outcome('NO_DATA');
    if (!answer.openCount) {
      return `En ${answer.business.name} no tienes pedidos pendientes por recibir.`;
    }
    const head = `En ${answer.business.name} tienes ${answer.openCount === 1 ? '1 pedido' : `${answer.openCount} pedidos`} por recibir, por unos ${speakCOP(answer.estimatedOpenCostCOP)}.`;
    const first = answer.items
      .slice(0, 3)
      .map((item) => item.name)
      .join(', ');
    return first ? `${head} Los primeros: ${first}.` : head;
  }

  private salesSpeech(answer: SalesAnswer): string {
    if (!answer.salesCount) this.outcome('NO_DATA');
    const { business, salesCount, revenueCOP } = answer;
    const when = periodLabel(answer.period);
    if (!salesCount) {
      return `No ${this.existed(answer.period)} ventas ${when} en ${business.name}.`;
    }
    // "Llevas" es de período abierto; ayer ya cerró y se cuenta en pasado.
    const verb = answer.period === 'yesterday' ? 'vendiste' : 'llevas';
    const head = `${this.capitalize(when)} en ${business.name} ${verb} ${revenueCOP} pesos en ${
      salesCount === 1 ? '1 venta' : `${salesCount} ventas`
    }, con un ticket promedio de ${answer.averageTicketCOP} pesos.`;
    // Lo fiado en el período es distinto de la cartera total: esa es
    // pending_payment. Decirlo acá evita que suene al mismo número.
    return answer.creditedCOP
      ? `${head} De eso, ${answer.creditedCOP} pesos quedaron fiados.`
      : head;
  }

  private deliverySpeech(answer: PendingDeliveryAnswer): string {
    if (!answer.salesCount) this.outcome('NO_DATA');
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

  /**
   * Valor del slot, prefiriendo el canónico sobre lo que se oyó.
   *
   * Cuando el slot es de tipo propio y Alexa acierta un sinónimo, deja el valor
   * de la lista en `resolutions`. Usar `slot.value` a secas desperdicia esos
   * sinónimos: el Echo transcribe "Bella Chic" como "bellachi", y solo el
   * canónico dice que eso era Bella Chic.
   */
  private slotValue(request: IntentRequest, name: string): string | undefined {
    const slot = request.intent.slots?.[name];
    if (!slot) return undefined;
    const matched = slot.resolutions?.resolutionsPerAuthority?.find(
      (authority) => authority.status.code === 'ER_SUCCESS_MATCH',
    );
    return matched?.values?.[0]?.value?.name ?? slot.value;
  }

  private capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /**
   * Tres nombres y el resto contado.
   *
   * Es la regla que hace usable el catálogo por voz: primero cuántos hay,
   * después unos pocos ejemplos, y "y N más" para cerrar. Leer la lista entera
   * no informa, agota.
   */
  private fewNames(names: string[], unit = 'más'): string {
    const shown = names.slice(0, MAX_NAMES);
    const rest = names.length - shown.length;
    return rest > 0
      ? `${shown.join(', ')} y ${rest} ${unit}`
      : shown.join(', ');
  }

  /**
   * Los tres rankings salen de la misma consulta y cambian solo en qué se lee.
   *
   * "El menos vendido" se responde con los que NO se vendieron, no con el que
   * vendió dos: quien pregunta eso quiere saber qué está quieto en la bodega.
   */
  private rankingSpeech(answer: SalesRankingAnswer, intent: string): string {
    const { business, products, variants, customers } = answer;
    const when = periodLabel(answer.period);
    const units = (n: number) => (n === 1 ? '1 unidad' : `${n} unidades`);

    if (intent === 'top_customers') {
      if (!customers.length) {
        return answer.counterSales
          ? `${this.capitalize(when)} en ${business.name} todas las ventas fueron de mostrador, sin cliente registrado.`
          : `No ${this.existed(answer.period)} ventas ${when} en ${business.name}.`;
      }
      const top = customers
        .slice(0, MAX_NAMES)
        .map((c) => `${c.name}, ${c.totalCOP} pesos`);
      // El mostrador se menciona aparte: si no, el "mejor cliente" puede ser
      // una fracción chica de lo que de verdad se vendió.
      const counter = answer.counterSales
        ? ` Hubo además ${answer.counterSales === 1 ? '1 venta' : `${answer.counterSales} ventas`} de mostrador sin cliente.`
        : '';
      return `${this.capitalize(when)} en ${business.name} quien más compró fue ${top.join('; ')}.${counter}`;
    }

    if (!products.length) {
      return `No ${this.existed(answer.period)} ventas ${when} en ${business.name}.`;
    }

    if (intent === 'worst_products') {
      // LA PREGUNTA ES OTRA DE LA QUE PARECE. Quien pregunta "¿qué se vende
      // menos?" no quiere el último del ranking —ese al menos vendió algo— sino
      // lo que está QUIETO. Eso es la plata detenida y es lo accionable; el
      // ranking de cola se deja de respaldo para cuando todo se movió.
      const unsold = answer.unsoldProducts ?? [];
      const quietVariants = answer.unsoldVariants ?? [];

      if (unsold.length) {
        const names = unsold.slice(0, MAX_NAMES).map((p) => p.name);
        const extra =
          unsold.length > names.length
            ? `, y ${unsold.length - names.length} más`
            : '';
        const aromas = quietVariants.length
          ? ` También hay ${quietVariants.length} ${
              quietVariants.length === 1 ? 'presentación' : 'presentaciones'
            } que nadie pidió.`
          : '';
        return `${this.capitalize(when)} en ${business.name} ${
          unsold.length === 1
            ? 'hay 1 producto que no vendió'
            : `hay ${unsold.length} productos que no vendieron`
        } ni una unidad: ${names.join('; ')}${extra}.${aromas}`;
      }

      const tail = [...products].reverse().slice(0, MAX_NAMES);
      if (!tail.length)
        return `${this.capitalize(when)} no hubo ventas en ${business.name}.`;
      return `${this.capitalize(when)} en ${business.name} se movió todo el catálogo. Lo que menos: ${tail
        .map((p) => `${p.name}, ${units(p.units)}`)
        .join('; ')}.`;
    }

    const top = products
      .slice(0, MAX_NAMES)
      .map((p) => `${p.name}, ${units(p.units)}`);
    const byVariant = variants.length
      ? ` La presentación más vendida fue ${variants[0].label}, con ${units(variants[0].units)}.`
      : '';
    return `${this.capitalize(when)} lo más vendido en ${business.name}: ${top.join('; ')}.${byVariant}`;
  }

  private catalogSpeech(answer: CatalogOverviewAnswer): string {
    if (!answer.productCount) this.outcome('NO_DATA');
    const { business, categories, productCount } = answer;
    if (!productCount) {
      return `${business.name} todavía no tiene productos cargados.`;
    }
    if (!categories.length) {
      return `${business.name} tiene ${productCount} productos, ninguno con categoría.`;
    }
    return `${business.name} tiene ${productCount} productos en ${
      categories.length === 1
        ? '1 categoría'
        : `${categories.length} categorías`
    }: ${this.fewNames(categories.map((c) => c.name))}. ¿Sobre cuál quieres preguntar?`;
  }

  private categorySpeech(
    answer: CatalogCategoryAnswer,
    spoken: string,
  ): string {
    if (!answer.productCount) this.outcome('NO_DATA');
    if (!answer.category) {
      return `No encuentro una categoría parecida a ${spoken}. Di: qué productos tienes, para oír las categorías.`;
    }
    const { category, productCount, products } = answer;
    // Los agotados van nombrados como tales: un cero suelto se oye como error.
    const examples = products.map((p) =>
      p.stock > 0 ? p.name : `${p.name}, agotado`,
    );
    return `En ${category.name} hay ${
      productCount === 1 ? '1 producto' : `${productCount} productos`
    }: ${this.fewNames(examples)}. ¿Cuál quieres?`;
  }

  private productSpeech(answer: ProductLookupAnswer, spoken: string): string {
    if (!answer.matchCount) this.outcome('NO_DATA');
    if (!answer.matchCount) {
      return `No encuentro ningún producto que se llame ${spoken}.`;
    }
    if (!answer.product) {
      // Demasiados: se pide acotar en vez de leer diez nombres.
      return `Hay ${answer.matchCount} productos que coinciden: ${this.fewNames(
        answer.candidates,
      )}. ¿Cuál de esos?`;
    }

    const { name, priceCOP, stock, trackStock, variants } = answer.product;
    const existence = !trackStock
      ? 'sin control de stock'
      : stock > 0
        ? `quedan ${stock} unidades`
        : 'agotado';
    const head = `${name}, ${priceCOP} pesos, ${existence}.`;

    if (!variants.length) return head;
    const available = variants.filter((v) => v.stock > 0);
    return `${head} Tiene ${variants.length} presentaciones${
      available.length < variants.length
        ? `, ${variants.length - available.length} agotadas`
        : ''
    }: ${this.fewNames(
      variants.map((v) => `${v.label}, ${v.stock > 0 ? v.stock : 'agotado'}`),
    )}.`;
  }

  private lowStockSpeech(answer: InventoryStatusAnswer): string {
    if (!answer.lowStockCount) this.outcome('NO_DATA');
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

  /**
   * Agotados, aparte de "bajo mínimo".
   *
   * El chat ya los separaba y la voz los mezclaba dentro de `low_stock`. Para
   * quien atiende no son la misma urgencia: lo bajo se repone esta semana, lo
   * agotado se está dejando de vender HOY. Meterlos en una sola respuesta
   * obliga a escuchar la lista entera para encontrar los ceros.
   */
  private outOfStockSpeech(answer: InventoryStatusAnswer): string {
    if (!answer.outOfStockCount) this.outcome('NO_DATA');
    const { business, lowStock, outOfStockCount, lowStockCount } = answer;
    const zeros = lowStock.filter((p) => p.stock === 0);

    if (!outOfStockCount) {
      return lowStockCount
        ? `En ${business.name} no tienes nada agotado. Eso sí, ${lowStockCount} ${
            lowStockCount === 1 ? 'producto está' : 'productos están'
          } por debajo del mínimo.`
        : `En ${business.name} no tienes nada agotado.`;
    }

    const head = `En ${business.name} tienes ${outOfStockCount} ${
      outOfStockCount === 1 ? 'producto agotado' : 'productos agotados'
    }.`;
    // Tres nombres como mucho, igual que en stock bajo: por voz una lista larga
    // no se retiene, y el conteo ya dio la magnitud.
    const names = zeros.slice(0, 3).map((p) => p.name);
    if (!names.length) return head;
    return `${head} ${names.length === 1 ? 'Es' : 'Son'}: ${names.join('; ')}.`;
  }

  private inventoryValueSpeech(answer: InventoryStatusAnswer): string {
    if (!answer.trackedProducts) this.outcome('NO_DATA');
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
    if (!answer.salesCount) this.outcome('NO_DATA');
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

  private async resolveActor(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
  ): Promise<ActorResult> {
    try {
      const actor = await this.auth.actor(envelope, skill);
      const state = this.observation.getStore();
      if (state && actor) state.roleCode = actor.roleCode;
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

  private fallback(envelope: RequestEnvelope): ResponseEnvelope {
    // No entender una consulta no implica que el acceso haya caducado.
    // El siguiente intent de negocio valida la autorización y el tenant de nuevo.
    const businessId = this.rememberedBusinessId(envelope);
    const suggestions =
      'Puedes decir: cuánto vendí hoy, qué se está agotando, o qué tengo por entregar.';
    return this.speak(
      `No entendí esa consulta. ${suggestions}`,
      false,
      suggestions,
      undefined,
      businessId ? { businessId } : undefined,
    );
  }

  /**
   * Si el dispositivo declara APL, se le manda el documento; si no, la
   * directiva se descarta del lado de Amazon y el usuario se queda sin
   * respuesta visual. Ni un Echo Dot ni la app de Alexa en el teléfono
   * soportan APL: por eso la tarjeta nunca se reemplaza, se suma.
   */
  private supportsApl(envelope: RequestEnvelope): boolean {
    const supported = Boolean(
      envelope.context?.System?.device?.supportedInterfaces?.[
        'Alexa.Presentation.APL'
      ],
    );
    // Queda en el log porque desde afuera no hay cómo distinguir "el
    // dispositivo no soporta APL" de "la skill no tiene la interfaz activa":
    // en los dos casos la pantalla se ve igual de vacía.
    this.logger.log(`APL support: ${supported}`);
    return supported;
  }

  private speak(
    text: string,
    shouldEndSession: boolean,
    reprompt = 'Puedes preguntarme cuántas suscripciones tienes.',
    card?: ui.Card,
    sessionAttributes?: Record<string, unknown>,
    directives?: Directive[],
  ): ResponseEnvelope {
    return {
      version: '1.0',
      // Alexa no guarda nada por su cuenta: lo que no se devuelve acá se pierde
      // en el siguiente turno.
      ...(sessionAttributes && { sessionAttributes }),
      response: {
        outputSpeech: { type: 'PlainText', text },
        ...(card && { card }),
        ...(directives?.length && { directives }),
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
