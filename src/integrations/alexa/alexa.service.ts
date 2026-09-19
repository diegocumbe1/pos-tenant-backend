import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AlexaSkill } from '@prisma/client';
import {
  SkillRequestSignatureVerifier,
  TimestampVerifier,
} from 'ask-sdk-express-adapter';
import {
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
  CatalogCategoryAnswer,
  CatalogOverviewAnswer,
  InventoryStatusAnswer,
  PendingDeliveryAnswer,
  PendingPaymentAnswer,
  PlatformOverviewAnswer,
  ProductLookupAnswer,
  SalesAnswer,
  SalesRankingAnswer,
} from '../../assistant/assistant.types';
import { periodLabel, parsePeriod } from '../../assistant/report-period';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import { AlexaAuthService } from './alexa-auth.service';
import { AlexaSkillRepository } from './alexa-skill.repository';

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
  'Para el detalle di: quién me debe, qué se está acabando, o qué tengo por entregar.';

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
    private readonly skills: AlexaSkillRepository,
    private readonly auth: AlexaAuthService,
    private readonly assistant: AssistantService,
    private readonly scope: AssistantScopeService,
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
        return this.handleIntent(envelope, skill, envelope.request);
      default:
        return this.fallback();
    }
  }

  private async launch(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
  ): Promise<ResponseEnvelope> {
    const result = await this.resolveActor(envelope, skill);
    if (result.status !== 'active') return this.reject(result);
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
          async (actor, business) =>
            this.debtSpeech(
              await this.assistant.pendingPayment(actor, business),
            ),
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
              card: this.reportCard(report),
            };
          },
        );
      case 'sales_summary':
        this.logger.log('IntentRequest: sales_summary');
        return this.forBusiness(
          envelope,
          skill,
          request,
          async (actor, business) =>
            this.salesSpeech(
              await this.assistant.sales(
                actor,
                business,
                parsePeriod(this.slotValue(request, PERIOD_SLOT)),
              ),
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
          if (!spoken) return '¿De cuál categoría?';
          return this.categorySpeech(
            await this.assistant.catalogCategory(a, b, spoken),
            spoken,
          );
        });
      case 'product_lookup':
        this.logger.log('IntentRequest: product_lookup');
        return this.forBusiness(envelope, skill, request, async (a, b) => {
          const spoken = this.slotValue(request, PRODUCT_SLOT);
          if (!spoken) return '¿De cuál producto?';
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
          'Puedes preguntarme cuántas suscripciones tienes, o por un negocio: cuánto vendí hoy, quién me debe, qué tengo por entregar, qué se está acabando, o cuánto vale mi inventario. Para activar el acceso di: mi código es, y tu frase.',
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
    skill: AlexaSkill,
    request: IntentRequest,
    answer: (
      actor: AuthenticatedUser,
      business: BusinessRef,
    ) => Promise<string | { speech: string; card: ui.Card }>,
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
        return this.speak(this.businessPrompt(resolution), false);
      }
      const result = await answer(actor, resolution.business);
      const { speech, card } =
        typeof result === 'string'
          ? { speech: result, card: undefined }
          : result;
      return this.speak(speech, false, '¿Quieres preguntar algo más?', card, {
        businessId: resolution.business.id,
      });
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
  private reportSpeech(report: BusinessReportAnswer): string {
    const { business, sales, debt, inventory, purchases, delivery } = report;
    const when = periodLabel(report.period);

    const first = sales.salesCount
      ? `${this.capitalize(when)} vendiste ${sales.revenueCOP} pesos en ${sales.salesCount === 1 ? '1 venta' : `${sales.salesCount} ventas`}.`
      : `No hay ventas ${when}.`;

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

  private salesSpeech(answer: SalesAnswer): string {
    const { business, salesCount, revenueCOP } = answer;
    const when = periodLabel(answer.period);
    if (!salesCount) {
      return `No hay ventas ${when} en ${business.name}.`;
    }
    const head = `${this.capitalize(when)} en ${business.name} llevas ${revenueCOP} pesos en ${
      salesCount === 1 ? '1 venta' : `${salesCount} ventas`
    }, con un ticket promedio de ${answer.averageTicketCOP} pesos.`;
    // Lo fiado en el período es distinto de la cartera total: esa es
    // pending_payment. Decirlo acá evita que suene al mismo número.
    return answer.creditedCOP
      ? `${head} De eso, ${answer.creditedCOP} pesos quedaron fiados.`
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
          : `No hay ventas ${when} en ${business.name}.`;
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
      return `No hay ventas ${when} en ${business.name}.`;
    }

    if (intent === 'worst_products') {
      const tail = [...products].reverse().slice(0, MAX_NAMES);
      const quiet = answer.unsoldCount
        ? ` Y hay ${answer.unsoldCount === 1 ? '1 producto que no vendiste' : `${answer.unsoldCount} productos que no vendiste`} ni una unidad.`
        : '';
      return `${this.capitalize(when)} lo menos vendido en ${business.name}: ${tail
        .map((p) => `${p.name}, ${units(p.units)}`)
        .join('; ')}.${quiet}`;
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

  private async resolveActor(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
  ): Promise<ActorResult> {
    try {
      const actor = await this.auth.actor(envelope, skill);
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
    card?: ui.Card,
    sessionAttributes?: Record<string, unknown>,
  ): ResponseEnvelope {
    return {
      version: '1.0',
      // Alexa no guarda nada por su cuenta: lo que no se devuelve acá se pierde
      // en el siguiente turno.
      ...(sessionAttributes && { sessionAttributes }),
      response: {
        outputSpeech: { type: 'PlainText', text },
        ...(card && { card }),
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
