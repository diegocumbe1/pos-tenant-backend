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
  IntentRequest,
  RequestEnvelope,
  ResponseEnvelope,
} from 'ask-sdk-model';
import { IncomingHttpHeaders } from 'http';
import { AssistantService } from '../../assistant/assistant.service';
import { matchBusinessName } from '../../assistant/spoken-name';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import {
  addCalendarDaysCO,
  calendarDayCO,
  dayEndCO,
  dayStartCO,
  diffCalendarDaysCO,
} from '../../common/date.util';
import { billingDatesOf } from '../../platform/alerts/billing-alert-rules';
import { PrismaService } from '../../prisma/prisma.service';
import {
  monthRange,
  parseAlexaDate,
  parseAlexaDuration,
  SpokenRange,
} from './alexa-dates';
import { AlexaAuthService } from './alexa-auth.service';
import {
  applicationIdOf,
  slotValueOf,
  verifyAlexaRequest,
} from './alexa-request';
import { AlexaSkillRepository } from './alexa-skill.repository';
import { overviewSpeech, paymentsSpeech } from './platform-speech';

const MAX_NAMES = 3;
const HINT =
  'Puedes preguntarme cómo va la plataforma, qué suscripciones vencen esta semana, o quién está en mora.';
const ASK_FOR_CODE =
  'Para usar la consola necesito tu código de activación. Di: mi código es, y tu frase.';
const DENIED = 'Esta cuenta de Alexa no está autorizada para usar la consola.';
const UNCONFIGURED =
  'La autorización por voz de la consola todavía no está configurada.';
const CONSOLE_ONLY =
  'Suspender, reactivar o extender una prueba se hace desde la consola de Lynko. Por voz solo consulto.';
const REPROMPT = '¿Qué más quieres consultar?';

/** Mismos estados que los avisos de cobro: lo que todavía se le puede cobrar. */
const OPEN_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE'] as const;

const STATUS_WORD: Record<string, string> = {
  ACTIVE: 'activa',
  SUSPENDED: 'suspendida',
  INACTIVE: 'inactiva',
};

/** Las consultas que un "¿y ayer?" o un "¿y en Bella Chic?" pueden repetir. */
const QUERIES = [
  'NewBusinessesIntent',
  'ExpiringSubscriptionsIntent',
  'RevenueIntent',
  'BusinessStatusIntent',
  'BusinessContactIntent',
] as const;
type Query = (typeof QUERIES)[number];
const BY_BUSINESS: Query[] = ['BusinessStatusIntent', 'BusinessContactIntent'];

interface Slots {
  negocio?: string;
  fecha?: string;
  duracion?: string;
}

/** Lo que Alexa nos devuelve en el siguiente turno. Nunca es permiso. */
interface Memory {
  lastIntent?: Query;
  lastSlots?: Slots;
  lastSpeech?: string;
}

interface Answer {
  speech: string;
  /** Hay más nombres de los que caben en la voz: van completos a la tarjeta. */
  cardLines?: string[];
  cardTitle?: string;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Lynko Admin: la consola de voz del super-admin. Solo lectura.
 *
 * Va aparte de `AlexaService` porque responde sobre la plataforma, no sobre un
 * negocio: solo comparte la firma de Amazon y la activación por frase. Las cifras
 * son exactas y dicen siempre el rango que usaron.
 */
@Injectable()
export class AlexaAdminService {
  private readonly logger = new Logger('AlexaAdmin');

  constructor(
    private readonly skills: AlexaSkillRepository,
    private readonly auth: AlexaAuthService,
    private readonly assistant: AssistantService,
    private readonly prisma: PrismaService,
  ) {}

  async handleRequest(
    rawBody: Buffer | undefined,
    headers: IncomingHttpHeaders,
  ): Promise<ResponseEnvelope> {
    const envelope = await verifyAlexaRequest(rawBody, headers, this.logger);
    const skill = await this.skills.byApplicationId(applicationIdOf(envelope));
    // Una skill atada a un negocio nunca entra a la consola de la plataforma.
    if (!skill || skill.tenantId) {
      this.logger.warn('Request from a skill that is not a platform skill');
      throw new UnauthorizedException('Invalid Alexa request');
    }

    switch (envelope.request.type) {
      case 'LaunchRequest':
        return this.guarded(envelope, skill, (actor) => {
          const name = actor.name?.trim().split(/\s+/)[0];
          return this.speak(
            `Hola${name ? ` ${name}` : ''}. Consola lista. ${HINT}`,
          );
        });
      case 'SessionEndedRequest':
        return { version: '1.0', response: {} };
      case 'IntentRequest':
        return this.handleIntent(envelope, skill, envelope.request);
      default:
        return this.speak(`No entendí esa consulta. ${HINT}`);
    }
  }

  private async handleIntent(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
    request: IntentRequest,
  ): Promise<ResponseEnvelope> {
    const name = request.intent.name;
    this.logger.log(`IntentRequest: ${name}`); // Nunca el valor de los slots.
    const memory = this.memoryOf(envelope);

    switch (name) {
      case 'ActivarLynkoIntent':
        return this.activate(envelope, skill, request);
      case 'CerrarAccesoIntent':
        return this.logout(envelope, skill);
      case 'BriefingIntent':
        return this.answer(envelope, skill, memory, (actor) =>
          this.briefing(actor),
        );
      case 'PlatformSummaryIntent':
      case 'GetSubscriptionsIntent':
        return this.answer(envelope, skill, memory, async (actor) => ({
          speech: overviewSpeech(await this.assistant.platformOverview(actor)),
        }));
      case 'FailedPaymentsIntent':
        return this.answer(envelope, skill, memory, () => this.overdue());
      case 'NewBusinessesIntent':
      case 'ExpiringSubscriptionsIntent':
      case 'RevenueIntent':
      case 'BusinessStatusIntent':
      case 'BusinessContactIntent':
        return this.runQuery(
          envelope,
          skill,
          memory,
          name,
          this.slotsOf(request),
        );
      case 'FollowUpIntent':
        return this.followUp(envelope, skill, memory, this.slotsOf(request));
      case 'AccionConsolaIntent':
        return this.guarded(envelope, skill, () =>
          this.speak(CONSOLE_ONLY, false, memory),
        );
      case 'AMAZON.RepeatIntent':
        return this.speak(
          memory.lastSpeech ?? `No tengo nada que repetir. ${HINT}`,
          false,
          memory,
        );
      case 'AMAZON.HelpIntent':
        return this.speak(
          `${HINT} También cuántos negocios nuevos hay, cuánto se cobró este mes, o cómo va un negocio. Para activar el acceso di: mi código es, y tu frase.`,
          false,
          memory,
        );
      case 'AMAZON.YesIntent':
      case 'AMAZON.NavigateHomeIntent':
        return this.speak(`Dime. ${HINT}`, false, memory);
      case 'AMAZON.NoIntent':
        return this.speak(
          'Listo. Aquí estoy si necesitas algo más.',
          false,
          memory,
        );
      case 'DespedidaIntent':
        return this.speak('Con gusto. Hasta luego.', true);
      case 'AMAZON.StopIntent':
      case 'AMAZON.CancelIntent':
        return this.speak('Hasta luego.', true);
      default:
        return this.speak(`No entendí esa consulta. ${HINT}`, false, memory);
    }
  }

  // ─── Acceso ───────────────────────────────────────────────────────────────

  private async activate(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
    request: IntentRequest,
  ): Promise<ResponseEnvelope> {
    const phrase = request.intent.slots?.codigo?.value?.trim();
    if (!phrase) {
      return this.speak(
        'No alcancé a escuchar el código. Di: mi código es, y luego tu frase.',
      );
    }
    let outcome: 'active' | 'invalid' | 'locked';
    try {
      outcome = await this.auth.activate(envelope, skill, phrase);
    } catch (error) {
      return this.rejection(error);
    }
    this.logger.log(`Activation attempt: ${outcome}`);
    if (outcome === 'active') {
      return this.speak(
        `Listo. Tu acceso a la consola queda activo ${skill.ttlDays} días. ${HINT}`,
      );
    }
    return outcome === 'locked'
      ? this.speak(
          'Demasiados intentos fallidos. Espera quince minutos antes de volver a intentarlo.',
          true,
        )
      : this.speak('Ese código no coincide. Inténtalo otra vez.');
  }

  private async logout(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
  ): Promise<ResponseEnvelope> {
    try {
      await this.auth.logout(envelope, skill);
    } catch (error) {
      return this.rejection(error);
    }
    return this.speak('Listo. Cerré tu acceso a la consola.', true);
  }

  /** Sesión vigente y usuario de plataforma, en cada turno. */
  private async guarded(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
    handler: (
      actor: AuthenticatedUser,
    ) => ResponseEnvelope | Promise<ResponseEnvelope>,
  ): Promise<ResponseEnvelope> {
    let actor: AuthenticatedUser | null;
    try {
      actor = await this.auth.actor(envelope, skill);
    } catch (error) {
      return this.rejection(error);
    }
    if (!actor) return this.speak(ASK_FOR_CODE);
    if (!actor.isPlatformAdmin) return this.speak(DENIED, true);
    return handler(actor);
  }

  private rejection(error: unknown): ResponseEnvelope {
    if (error instanceof ServiceUnavailableException) {
      return this.speak(UNCONFIGURED, true);
    }
    if (error instanceof ForbiddenException) return this.speak(DENIED, true);
    throw error;
  }

  // ─── Consultas ────────────────────────────────────────────────────────────

  private answer(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
    memory: Memory,
    run: (actor: AuthenticatedUser) => Promise<Answer>,
    next: Memory = {},
  ): Promise<ResponseEnvelope> {
    return this.guarded(envelope, skill, async (actor) => {
      const { speech, cardLines, cardTitle } = await run(actor);
      return this.speak(
        speech,
        false,
        { ...memory, ...next, lastSpeech: speech },
        cardLines?.length
          ? {
              type: 'Simple',
              title: cardTitle ?? 'Consola Lynko',
              content: cardLines.join('\n'),
            }
          : undefined,
      );
    });
  }

  private runQuery(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
    memory: Memory,
    intent: Query,
    slots: Slots,
  ): Promise<ResponseEnvelope> {
    return this.answer(
      envelope,
      skill,
      memory,
      (actor) => this.query(actor, intent, slots),
      { lastIntent: intent, lastSlots: slots },
    );
  }

  private query(
    actor: AuthenticatedUser,
    intent: Query,
    slots: Slots,
  ): Promise<Answer> {
    switch (intent) {
      case 'NewBusinessesIntent':
        return this.newBusinesses(slots);
      case 'ExpiringSubscriptionsIntent':
        return this.expiring(slots);
      case 'RevenueIntent':
        return this.revenue(slots);
      case 'BusinessStatusIntent':
        return this.businessStatus(actor, slots);
      case 'BusinessContactIntent':
        return this.businessContact(slots);
    }
  }

  /** "¿Y ayer?": repite la consulta anterior con lo que cambió. */
  private followUp(
    envelope: RequestEnvelope,
    skill: AlexaSkill,
    memory: Memory,
    slots: Slots,
  ): Promise<ResponseEnvelope> {
    const last = memory.lastIntent;
    // Nombrar un negocio después de una consulta global pide su estado.
    if (slots.negocio && (!last || !BY_BUSINESS.includes(last))) {
      return this.runQuery(
        envelope,
        skill,
        memory,
        'BusinessStatusIntent',
        slots,
      );
    }
    if (!last) {
      return this.guarded(envelope, skill, () =>
        this.speak(`¿Sobre qué consulta? ${HINT}`, false, memory),
      );
    }
    if (!slots.negocio && BY_BUSINESS.includes(last)) {
      return this.guarded(envelope, skill, () =>
        this.speak(
          'De un negocio solo tengo cómo está hoy. Dime de cuál otro quieres saber.',
          false,
          memory,
        ),
      );
    }
    return this.runQuery(envelope, skill, memory, last, {
      ...memory.lastSlots,
      ...slots,
    });
  }

  private async newBusinesses(slots: Slots): Promise<Answer> {
    const now = new Date();
    const today = calendarDayCO(now);
    const [year, month] = today.split('-').map(Number);
    const range =
      parseAlexaDuration(slots.duracion, now) ??
      parseAlexaDate(slots.fecha, now) ??
      monthRange(year, month, today);
    const tenants = await this.prisma.tenant.findMany({
      where: {
        deletedAt: null,
        createdAt: { gte: dayStartCO(range.from), lte: dayEndCO(range.to) },
      },
      select: { name: true },
      orderBy: { createdAt: 'desc' },
    });
    const names = tenants.map((t) => t.name.trim());
    if (!names.length) {
      return { speech: `${capitalize(range.label)} no entró ningún negocio.` };
    }
    return {
      speech: `${capitalize(range.label)} ${names.length === 1 ? 'entró 1 negocio' : `entraron ${names.length} negocios`}: ${this.few(names)}.`,
      cardTitle: 'Negocios nuevos',
      cardLines: names,
    };
  }

  /** Todas las cuentas abiertas con su vencimiento, igual que la consola. */
  private async openAccounts() {
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        status: { in: [...OPEN_STATUSES] },
        tenant: { status: 'ACTIVE', deletedAt: null },
      },
      select: {
        status: true,
        trialEndsAt: true,
        nextPaymentDueAt: true,
        currentPeriodEnd: true,
        graceEndsAt: true,
        tenant: { select: { name: true } },
      },
    });
    return subscriptions
      .map((sub) => ({
        name: sub.tenant.name.trim(),
        trial: sub.status === 'TRIALING' && Boolean(sub.trialEndsAt),
        dueDay: billingDatesOf(sub).dueDay,
      }))
      .sort((a, b) => a.dueDay.localeCompare(b.dueDay));
  }

  private async expiring(slots: Slots): Promise<Answer> {
    const now = new Date();
    const today = calendarDayCO(now);
    const range: SpokenRange = parseAlexaDate(slots.fecha, now) ?? {
      from: today,
      to: addCalendarDaysCO(today, 7),
      label: 'en los próximos 7 días',
    };
    const due = (await this.openAccounts()).filter(
      (a) => a.dueDay >= range.from && a.dueDay <= range.to,
    );
    if (!due.length) {
      return { speech: `${capitalize(range.label)} no vence ninguna cuenta.` };
    }
    const lines = due.map(
      (a) =>
        `${a.name}${a.trial ? ' (prueba)' : ''}, ${this.dayWord(a.dueDay, today)}`,
    );
    return {
      speech: `${capitalize(range.label)} ${due.length === 1 ? 'vence 1 cuenta' : `vencen ${due.length} cuentas`}: ${this.few(lines, '; ')}.`,
      cardTitle: 'Vencimientos',
      cardLines: lines,
    };
  }

  private async overdue(): Promise<Answer> {
    const today = calendarDayCO(new Date());
    const late = (await this.openAccounts()).filter((a) => a.dueDay < today);
    if (!late.length) return { speech: 'No hay cuentas vencidas sin pago.' };
    const lines = late.map((a) => {
      const days = diffCalendarDaysCO(a.dueDay, today);
      return `${a.name}, ${plural(days, 'día', 'días')}`;
    });
    return {
      speech: `Hay ${plural(late.length, 'cuenta vencida', 'cuentas vencidas')} sin pago: ${this.few(lines, '; ')}.`,
      cardTitle: 'Cuentas vencidas',
      cardLines: lines,
    };
  }

  /** Lo cobrado de verdad: `countsAsRevenue` deja fuera bonos y notas crédito. */
  private async revenue(slots: Slots): Promise<Answer> {
    const now = new Date();
    const today = calendarDayCO(now);
    const [year, month] = today.split('-').map(Number);
    const range =
      parseAlexaDate(slots.fecha, now) ?? monthRange(year, month, today);
    const rows = await this.prisma.subscriptionPayment.groupBy({
      by: ['currency'],
      where: {
        countsAsRevenue: true,
        paidAt: { gte: dayStartCO(range.from), lte: dayEndCO(range.to) },
      },
      _count: true,
      _sum: { amount: true },
    });
    if (!rows.length) {
      return { speech: `${capitalize(range.label)} no se registraron pagos.` };
    }
    // Monedas por separado: sumarlas daría una cifra que no existe.
    const parts = rows.map(
      (row) =>
        `${row._sum.amount ?? 0} ${row.currency === 'COP' ? 'pesos' : row.currency === 'USD' ? 'dólares' : row.currency} en ${plural(row._count, 'pago', 'pagos')}`,
    );
    return {
      speech: `${capitalize(range.label)} se cobraron ${parts.join(', y ')}.`,
    };
  }

  /** Con suspendidos incluidos: "cómo va" tiene que poder decir que está suspendido. */
  private async findBusiness(spoken: string | undefined) {
    if (!spoken?.trim()) return { speech: '¿De cuál negocio?' } as const;
    const tenants = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        status: true,
        plan: true,
        vertical: { select: { code: true } },
        subscription: {
          select: {
            status: true,
            trialEndsAt: true,
            nextPaymentDueAt: true,
            currentPeriodEnd: true,
            graceEndsAt: true,
          },
        },
      },
    });
    const match = matchBusinessName(
      tenants.map((t) => ({ ...t, name: t.name.trim() })),
      spoken,
    );
    if (match.status === 'resolved')
      return { business: match.business } as const;
    return {
      speech:
        match.status === 'ambiguous'
          ? `¿Te refieres a ${match.matches
              .slice(0, MAX_NAMES)
              .map((b) => b.name)
              .join(' o a ')}?`
          : 'No encuentro ese negocio. Dime el nombre otra vez.',
    } as const;
  }

  private async businessStatus(
    actor: AuthenticatedUser,
    slots: Slots,
  ): Promise<Answer> {
    const found = await this.findBusiness(slots.negocio);
    if (!found.business) return { speech: found.speech };
    const { business } = found;
    const today = calendarDayCO(new Date());
    const parts = [
      `${business.name} está ${STATUS_WORD[business.status] ?? business.status.toLowerCase()}, plan ${business.plan.toLowerCase()}.`,
    ];
    if (business.subscription) {
      const dueDay = billingDatesOf(business.subscription).dueDay;
      const trial =
        business.subscription.status === 'TRIALING' &&
        business.subscription.trialEndsAt;
      parts.push(
        `${trial ? 'Su prueba' : 'Su suscripción'} ${dueDay < today ? 'venció' : 'vence'} ${this.dayWord(dueDay, today)}.`,
      );
    }
    parts.push(await this.salesToday(actor, business));
    return { speech: parts.filter(Boolean).join(' ') };
  }

  /** Solo retail tiene ventas en el asistente: otra vertical simplemente no las nombra. */
  private async salesToday(
    actor: AuthenticatedUser,
    business: { id: string; name: string; vertical: { code: string } | null },
  ): Promise<string> {
    try {
      const { salesCount, revenueCOP } = await this.assistant.sales(
        actor,
        business,
        'day',
      );
      return salesCount
        ? `Hoy lleva ${revenueCOP} pesos en ${plural(salesCount, 'venta', 'ventas')}.`
        : 'Hoy no registra ventas.';
    } catch (error) {
      if (error instanceof BadRequestException) return '';
      throw error;
    }
  }

  /** Nombre y rol. Nunca el teléfono ni el correo: esto se oye en toda la sala. */
  private async businessContact(slots: Slots): Promise<Answer> {
    const found = await this.findBusiness(slots.negocio);
    if (!found.business) return { speech: found.speech };
    const { business } = found;
    const contact = await this.prisma.billingContact.findFirst({
      where: { tenantId: business.id },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { name: true, role: true },
    });
    return {
      speech: contact
        ? `El contacto de ${business.name} es ${contact.name}${contact.role ? `, ${contact.role}` : ''}.`
        : `${business.name} no tiene contacto registrado.`,
    };
  }

  private async briefing(actor: AuthenticatedUser): Promise<Answer> {
    const now = new Date();
    const today = calendarDayCO(now);
    const yesterday = addCalendarDaysCO(today, -1);
    const [overview, accounts, newOnes] = await Promise.all([
      this.assistant.platformOverview(actor),
      this.openAccounts(),
      this.prisma.tenant.count({
        where: {
          deletedAt: null,
          createdAt: { gte: dayStartCO(yesterday), lte: dayEndCO(yesterday) },
        },
      }),
    ]);
    const dueToday = accounts
      .filter((a) => a.dueDay === today)
      .map((a) => a.name);
    const late = accounts.filter((a) => a.dueDay < today).length;
    return {
      speech: [
        paymentsSpeech(overview),
        dueToday.length
          ? `Hoy ${dueToday.length === 1 ? 'vence' : 'vencen'} ${this.few(dueToday)}.`
          : 'Hoy no vence ninguna cuenta.',
        late
          ? `Hay ${plural(late, 'cuenta vencida', 'cuentas vencidas')} sin pago.`
          : 'No hay cuentas vencidas.',
        newOnes
          ? `Ayer ${newOnes === 1 ? 'entró 1 negocio' : `entraron ${newOnes} negocios`}.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  }

  // ─── Redacción ────────────────────────────────────────────────────────────

  /** Por voz no se retienen más de tres nombres; el resto se cuenta. */
  private few(items: string[], joiner = ', '): string {
    const shown = items.slice(0, MAX_NAMES);
    const rest = items.length - shown.length;
    return rest > 0
      ? `${shown.join(joiner)}, y ${rest} más`
      : shown.join(joiner);
  }

  private dayWord(day: string, today: string): string {
    if (day === today) return 'hoy';
    if (day === addCalendarDaysCO(today, 1)) return 'mañana';
    if (day === addCalendarDaysCO(today, -1)) return 'ayer';
    return parseAlexaDate(day)?.label ?? day;
  }

  private slotsOf(request: IntentRequest): Slots {
    return {
      ...this.defined('negocio', slotValueOf(request, 'negocio')),
      ...this.defined('fecha', request.intent.slots?.fecha?.value),
      ...this.defined('duracion', request.intent.slots?.duracion?.value),
    };
  }

  private defined(key: keyof Slots, value: string | undefined): Slots {
    return value ? { [key]: value } : {};
  }

  /** Viaja por Alexa: solo se usa para conversar, y lo que nombra se vuelve a buscar. */
  private memoryOf(envelope: RequestEnvelope): Memory {
    const raw = (envelope.session?.attributes ?? {}) as Record<string, unknown>;
    const lastIntent = QUERIES.find((q) => q === raw.lastIntent);
    return {
      ...(lastIntent && { lastIntent }),
      ...(raw.lastSlots && typeof raw.lastSlots === 'object'
        ? { lastSlots: raw.lastSlots as Slots }
        : {}),
      ...(typeof raw.lastSpeech === 'string'
        ? { lastSpeech: raw.lastSpeech }
        : {}),
    };
  }

  private speak(
    text: string,
    end = false,
    memory?: Memory,
    card?: { type: 'Simple'; title: string; content: string },
  ): ResponseEnvelope {
    return {
      version: '1.0',
      ...(memory && { sessionAttributes: { ...memory } }),
      response: {
        outputSpeech: { type: 'PlainText', text },
        ...(card && { card }),
        shouldEndSession: end,
        ...(!end && {
          reprompt: { outputSpeech: { type: 'PlainText', text: REPROMPT } },
        }),
      },
    };
  }
}
