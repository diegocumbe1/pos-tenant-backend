import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AssistantChannel } from '@prisma/client';
import { normalizePhone } from '../../platform-messaging/phone.util';
import {
  PLATFORM_SESSION_TENANT_ID,
  WhatsAppMessageEvent,
  WhatsAppSessionManager,
} from '../../whatsapp/whatsapp-session.manager';
import { MessagingSettingsService } from '../../platform-messaging/services/messaging-settings.service';
import { ConversationService } from '../conversation/conversation.service';
import { LynkoAgentService } from '../agent/lynko-agent.service';
import { AssistantTelemetryService } from '../telemetry/telemetry.service';

/** Ventana en la que un saliente puede ser todavía el eco de nuestro envío. */
const OWN_SEND_TTL_MS = 30_000;
/** Cuánto vale el interruptor cacheado antes de volver a leerlo. */
const SWITCH_TTL_MS = 15_000;
/** Cuántos mensajes recientes se recuerdan para diagnóstico. */
const TRACE_SIZE = 30;

/**
 * Silencio que hay que esperar antes de contestar una ráfaga.
 *
 * Tres segundos es lo que tarda alguien en mandar el segundo mensaje de una
 * idea partida en dos. Subirlo hace la conversación lenta; bajarlo devuelve el
 * problema de contestar tres veces.
 */
const DEBOUNCE_MS = Number(process.env.WA_AGENT_DEBOUNCE_MS ?? 3000);
/** Arranque de la pausa de tecleo, antes de sumar el largo del texto. */
const TYPING_BASE_MS = 900;
/** ~45 palabras por minuto. */
const TYPING_MS_PER_CHAR = 22;
const MAX_TYPING_MS = Number(process.env.WA_AGENT_MAX_TYPING_MS ?? 6000);
/** Conversaciones en vuelo a la vez. Es un tope de memoria, no de negocio. */
const MAX_PENDING_CHATS = 200;
/** Una ráfaga más larga que esto es ruido o un pegado: se corta. */
const MAX_MESSAGE_CHARS = 1000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Una ráfaga de mensajes esperando a que su autor termine de escribir. */
interface PendingBurst {
  phone: string;
  /** El último evento, para el diagnóstico. */
  event: WhatsAppMessageEvent;
  parts: string[];
  timer: NodeJS.Timeout;
}

/** Un mensaje que pasó por el agente y qué se hizo con él. Sin el texto. */
export interface InboundTrace {
  at: string;
  /** Últimos cuatro dígitos: alcanza para reconocer el chat, no para listarlo. */
  chatId: string;
  fromMe: boolean;
  type: string;
  outcome: string;
}

/** '573001234567@c.us' → '…4567@c.us'. */
function maskChatId(chatId: string): string {
  const [id, domain = ''] = chatId.split('@');
  return `…${id.slice(-4)}@${domain}`;
}

/**
 * WhatsApp como canal del agente: recibe, entrega, y ejecuta lo que el agente
 * decida. Nada más.
 *
 * Aquí NO hay lógica de negocio, ni de permisos, ni de intents: si algo de eso
 * termina en este archivo, está en el lugar equivocado. El adaptador de Alexa
 * hace lo mismo con voz, y el del chat web hará lo mismo con una pantalla.
 *
 * Dos decisiones que vale la pena dejar escritas:
 *
 * 1. **Solo atiende la sesión de la plataforma.** Cada negocio conecta su propio
 *    WhatsApp en Ajustes, y ahí entran mensajes de SUS clientes. Responderles el
 *    menú de Lynko sería un incidente, no una función.
 * 2. **Apagado por defecto** (`WA_AGENT_ENABLED`). Es el número real de la
 *    empresa: que empiece a contestar solo tiene que ser una decisión explícita.
 */
@Injectable()
export class WhatsAppInboundService {
  private readonly logger = new Logger('WhatsAppAgent');
  /** Lo que acabamos de enviar, para no confundir nuestro eco con una persona. */
  private readonly ownSends = new Map<string, { body: string; at: number }[]>();

  /** El interruptor de la consola, cacheado unos segundos. Ver `isEnabled`. */
  private cachedSwitch: { value: boolean; at: number } | null = null;
  /** Los últimos mensajes y su desenlace, para el diagnóstico de la consola. */
  private readonly recent: InboundTrace[] = [];
  /**
   * Ráfagas esperando a que su autor termine de escribir.
   *
   * En memoria y no en base: son segundos de vida. Si el backend se reinicia
   * se pierde una respuesta pendiente, que es mucho menos costoso que mantener
   * una tabla de trabajos para esto.
   */
  private readonly pending = new Map<string, PendingBurst>();

  constructor(
    private readonly agent: LynkoAgentService,
    private readonly conversations: ConversationService,
    private readonly sessions: WhatsAppSessionManager,
    private readonly telemetry: AssistantTelemetryService,
    private readonly settings: MessagingSettingsService,
  ) {}

  /**
   * ¿El agente contesta?
   *
   * Manda la consola (`PlatformMessagingSettings.agentEnabled`), no el entorno:
   * apagar un agente que le está hablando a los clientes no puede depender de
   * un redeploy. `WA_AGENT_ENABLED` queda como el valor de arranque para
   * ambientes sin base configurada, y en producción es `false`.
   *
   * La respuesta se cachea unos segundos: llega un evento por cada mensaje
   * —incluidos los nuestros— y no tiene sentido consultar la fila en cada uno.
   * El precio es que apagar el agente tarda hasta `SWITCH_TTL_MS` en surtir
   * efecto, que para un interruptor de este tipo es aceptable.
   */
  private async isEnabled(): Promise<boolean> {
    const now = Date.now();
    if (this.cachedSwitch && now - this.cachedSwitch.at < SWITCH_TTL_MS) {
      return this.cachedSwitch.value;
    }
    try {
      const { agentEnabled } = await this.settings.get();
      this.cachedSwitch = { value: agentEnabled, at: now };
      return agentEnabled;
    } catch (err) {
      // Sin base no se adivina: se cae al default del entorno, que es apagado.
      this.logger.warn(
        `No se pudo leer el interruptor del agente: ${(err as Error).message}`,
      );
      return process.env.WA_AGENT_ENABLED === 'true';
    }
  }

  /** Par de sesión que atiende el agente. Configurable, pero con un default seguro. */
  private get session(): { tenantId: string; branchId: string } {
    return {
      tenantId: process.env.WA_AGENT_TENANT_ID ?? PLATFORM_SESSION_TENANT_ID,
      branchId: process.env.WA_AGENT_BRANCH_ID ?? PLATFORM_SESSION_TENANT_ID,
    };
  }

  @OnEvent('wa.message')
  async onMessage(event: WhatsAppMessageEvent): Promise<void> {
    const session = this.session;
    const mine =
      event.tenantId === session.tenantId &&
      event.branchId === session.branchId;
    // Los mensajes de las sesiones de los tenants no son del agente y no se
    // registran siquiera: son conversaciones privadas de otro negocio.
    if (!mine) return;

    if (!(await this.isEnabled())) {
      this.trace(event, 'agente apagado');
      return;
    }
    // Grupos, estados, listas de difusión y canales: no se responden. Un agente
    // contestando en un grupo es ruido garantizado. Se rechaza por lo que SÍ
    // sabemos que no sirve, y no aceptando solo `@c.us`: WhatsApp ya entrega
    // chats normales como `…@lid`, y esa lista blanca los descartaba a todos.
    if (
      /@(g\.us|broadcast|newsletter)$/.test(event.chatId) ||
      event.chatId === 'status@broadcast'
    ) {
      this.trace(event, 'no es un chat directo');
      return;
    }

    const phone = event.phone ? this.normalize(event.phone) : null;
    if (!phone) {
      // Sin teléfono no hay a quién identificar. Pasa con los LID que la
      // librería no logra traducir; se deja constancia porque es la diferencia
      // entre "no llegó" y "llegó y no supe de quién era".
      this.trace(event, 'no se pudo resolver el teléfono');
      return;
    }

    try {
      if (event.fromMe) {
        const takeover = await this.handleOutgoing(phone, event.body);
        if (takeover) {
          // Una persona entró al chat: lo que el agente tenía preparado se
          // tira. Responder ahora sería hablarle encima a un asesor que ya
          // está escribiendo, que es peor que no responder.
          this.cancelPending(event.chatId, 'entró una persona');
        }
        this.trace(
          event,
          takeover
            ? 'respuesta manual: agente en silencio'
            : 'lo envió el agente',
        );
        return;
      }
      if (event.type !== 'chat' || !event.body.trim()) {
        // Audios, fotos y adjuntos: todavía no se saben leer. Callarse es mejor
        // que responder "no entendí" a una nota de voz.
        this.trace(event, `sin texto (${event.type})`);
        return;
      }

      this.enqueue(event, phone);
    } catch (err) {
      // Nunca se le responde al usuario un error técnico, y nunca se tumba la
      // sesión de WhatsApp por una consulta.
      this.logger.error(
        `Fallo atendiendo un mensaje: ${(err as Error).message}`,
      );
      this.trace(event, `error: ${(err as Error).message}`);
    }
  }

  /**
   * Agrupa la ráfaga y responde una sola vez.
   *
   * "Hola" · "buenas" · "una pregunta" en cinco segundos son TRES eventos. Sin
   * esto el agente corre tres veces —tres resoluciones de identidad, tres
   * consultas— y contesta tres veces. Nadie escribe así, y el servidor hace el
   * triple de trabajo para un resultado peor.
   *
   * La espera se reinicia con cada mensaje nuevo: mientras la persona siga
   * escribiendo, no se procesa nada. Cuando por fin para, se atiende todo junto
   * y con el contexto completo.
   */
  private enqueue(event: WhatsAppMessageEvent, phone: string): void {
    const chatId = event.chatId;
    const existing = this.pending.get(chatId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.parts.push(event.body);
      existing.timer = setTimeout(() => void this.flush(chatId), DEBOUNCE_MS);
      return;
    }

    // Tope de conversaciones en vuelo: si algo se desboca, se prefiere no
    // responderle a alguien antes que quedarse sin memoria.
    if (this.pending.size >= MAX_PENDING_CHATS) {
      this.trace(event, 'demasiadas conversaciones en curso');
      return;
    }

    this.pending.set(chatId, {
      phone,
      event,
      parts: [event.body],
      timer: setTimeout(() => void this.flush(chatId), DEBOUNCE_MS),
    });
  }

  private cancelPending(chatId: string, reason: string): void {
    const pending = this.pending.get(chatId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(chatId);
    this.logger.log(`Respuesta pendiente descartada: ${reason}`);
  }

  /** Procesa la ráfaga acumulada de un chat y responde una vez. */
  private async flush(chatId: string): Promise<void> {
    const pending = this.pending.get(chatId);
    if (!pending) return;
    this.pending.delete(chatId);
    const { event, phone, parts } = pending;
    // Los mensajes sueltos se unen con salto de línea: para el resolutor de
    // intents es un solo texto, y "¿y ayer?" después de "hola" se entiende.
    const message = parts.join('\n').slice(0, MAX_MESSAGE_CHARS);

    try {
      const started = Date.now();
      const result = await this.agent.process({
        channel: AssistantChannel.WHATSAPP,
        externalUserId: phone,
        message,
      });

      // Mientras se resolvía la consulta pudo llegar otro mensaje (hay una
      // entrada nueva en `pending`) o pudo entrar un asesor. En los dos casos
      // esta respuesta ya no corresponde: se descarta y la nueva ráfaga la
      // recalculará con el contexto completo.
      if (this.pending.has(chatId)) {
        this.trace(event, 'descartada: llegó otro mensaje');
        return;
      }

      if (result.action !== 'IGNORE' && result.reply) {
        await this.send(chatId, phone, result.reply);
      }
      if (result.action === 'HUMAN_HANDOFF') {
        // Fase 1: queda en el log. El aviso al equipo es el paso siguiente.
        this.logger.log(`Handoff sugerido (${result.reason ?? 'sin razón'})`);
      }
      // El `identity` es lo que explica el caso más confuso de todos: "me
      // saludó pero me trató como desconocido". Sin esto hay que ir a mirar la
      // base para saber si el teléfono resolvió a una cuenta o no.
      this.trace(
        event,
        [
          result.action,
          result.context.identity === 'USER' ? 'cuenta' : 'sin cuenta',
          result.context.intent,
          parts.length > 1 ? `${parts.length} mensajes` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      );
      this.record(result, started);
    } catch (err) {
      this.logger.error(
        `Fallo atendiendo un mensaje: ${(err as Error).message}`,
      );
      this.trace(event, `error: ${(err as Error).message}`);
    }
  }

  /**
   * Deja constancia de qué llegó y qué se hizo con ello.
   *
   * Existe porque el modo de fallo de esto es el silencio: un mensaje que no se
   * responde se ve exactamente igual que un mensaje que nunca llegó, y desde la
   * consola no hay forma de distinguirlos. Guarda los últimos 30 en memoria
   * —se pierden al reiniciar, y está bien: es para mirar ahora, no un histórico—
   * y NUNCA el texto del mensaje: solo de quién venía, enmascarado, y el
   * desenlace.
   */
  private trace(event: WhatsAppMessageEvent, outcome: string): void {
    this.recent.unshift({
      at: new Date().toISOString(),
      chatId: maskChatId(event.chatId),
      fromMe: event.fromMe,
      type: event.type,
      outcome,
    });
    if (this.recent.length > TRACE_SIZE) this.recent.length = TRACE_SIZE;
    this.logger.log(
      `${event.fromMe ? '←' : '→'} ${maskChatId(event.chatId)} · ${outcome}`,
    );
  }

  /** Lo que ve la consola para saber si los mensajes están llegando. */
  diagnostics(): {
    enabled: boolean;
    session: { tenantId: string; branchId: string };
    recent: InboundTrace[];
  } {
    return {
      enabled: this.cachedSwitch?.value ?? false,
      session: this.session,
      recent: this.recent,
    };
  }

  /**
   * Un mensaje que salió de nuestra cuenta.
   *
   * Si fue el agente, se descarta. Si no, lo escribió una persona del equipo
   * —desde el celular o desde WhatsApp Web— y el agente se calla en ese chat
   * durante unas horas. Es la única heurística del módulo y es deliberadamente
   * conservadora: prefiere callarse de más.
   */
  private async handleOutgoing(phone: string, body: string): Promise<boolean> {
    if (this.consumeOwnSend(phone, body)) return false;
    await this.conversations.markHumanTakeover(
      AssistantChannel.WHATSAPP,
      phone,
    );
    this.logger.log('Un mensaje manual tomó el chat: el agente se silencia');
    return true;
  }

  /**
   * Envía con el ritmo de alguien que escribe, no con el de una máquina.
   *
   * Dos cosas distintas, y conviene no confundirlas: esto **no** es simular ser
   * una persona —el agente se presenta como asistente y lo dice si se lo
   * preguntan—, es evitar que una respuesta formateada aparezca en 300 ms, que
   * se lee como un volante automático y hace que nadie termine de leerla.
   *
   * Mientras espera manda el estado "escribiendo…", que es lo que hace honesta
   * la pausa: el otro ve que algo está pasando en vez de quedar mirando el
   * silencio. Sin eso, esperar solo se siente como que lo dejaron en visto.
   *
   * La demora es proporcional al largo de la respuesta y va con tope: quien
   * pregunta cuánto vendió hoy está mirando la pantalla, y hacerlo esperar
   * medio minuto por una cifra no es más humano, es peor servicio.
   */
  private async send(
    chatId: string,
    phone: string,
    body: string,
  ): Promise<void> {
    const { tenantId, branchId } = this.session;
    const client = this.sessions.getClient(tenantId, branchId);
    if (!client) {
      this.logger.warn('No hay cliente de WhatsApp para responder');
      return;
    }

    const chat = await client.getChatById(chatId).catch(() => null);
    const pause = Math.min(
      MAX_TYPING_MS,
      TYPING_BASE_MS + body.length * TYPING_MS_PER_CHAR,
    );
    if (chat) {
      await chat.sendSeen().catch(() => undefined);
      await chat.sendStateTyping().catch(() => undefined);
    }
    await sleep(pause);

    // Se vuelve a mirar DESPUÉS de la pausa: en esos segundos pudo llegar otro
    // mensaje o pudo entrar un asesor. Esta es la última oportunidad de callar
    // una respuesta que ya no corresponde.
    if (this.pending.has(chatId)) {
      await chat?.clearState().catch(() => undefined);
      this.logger.log(
        'Respuesta descartada durante la pausa: llegó otro mensaje',
      );
      return;
    }

    // Se marca ANTES de enviar: `message_create` puede llegar antes de que
    // `sendMessage` resuelva, y si no estuviera marcado el agente se tomaría a
    // sí mismo por una persona y se silenciaría solo.
    this.rememberOwnSend(phone, body);
    await client.sendMessage(chatId, body);
    await chat?.clearState().catch(() => undefined);
  }

  private rememberOwnSend(key: string, body: string): void {
    const now = Date.now();
    const pending = (this.ownSends.get(key) ?? []).filter(
      (entry) => now - entry.at < OWN_SEND_TTL_MS,
    );
    pending.push({ body, at: now });
    this.ownSends.set(key, pending);
  }

  private consumeOwnSend(key: string, body: string): boolean {
    const now = Date.now();
    const pending = (this.ownSends.get(key) ?? []).filter(
      (entry) => now - entry.at < OWN_SEND_TTL_MS,
    );
    const index = pending.findIndex((entry) => entry.body === body);
    if (index === -1) {
      this.ownSends.set(key, pending);
      return false;
    }
    pending.splice(index, 1);
    this.ownSends.set(key, pending);
    return true;
  }

  /** Dígitos con indicativo, o null si no es un teléfono usable. */
  private normalize(phone: string): string | null {
    try {
      return normalizePhone(phone);
    } catch {
      return null;
    }
  }

  /**
   * Telemetría: intent y resultado, nunca el mensaje ni el teléfono.
   *
   * Solo se registra cuando hay tenant resuelto, que es lo que el log exige y
   * lo único que tiene sentido agregar: una conversación comercial con un
   * desconocido no es una consulta de negocio.
   */
  private record(
    result: Awaited<ReturnType<LynkoAgentService['process']>>,
    started: number,
  ): void {
    if (!result.context.tenantId || !result.context.vertical) return;
    this.telemetry.record(
      {
        tenantId: result.context.tenantId,
        roleCode: result.context.roleCode ?? 'OTHER',
      },
      [
        {
          vertical: result.context.vertical,
          intentId: result.context.intent,
          outcome:
            result.action === 'RESPOND'
              ? 'ANSWERED'
              : result.action === 'CLARIFY'
                ? 'CLARIFIED'
                : 'FALLBACK',
          confidence: result.action === 'RESPOND' ? 'HIGH' : 'MEDIUM',
          level: 'READ',
          resolvedTo: null,
          latencyMs: Date.now() - started,
        },
      ],
      'WHATSAPP',
    );
  }
}
