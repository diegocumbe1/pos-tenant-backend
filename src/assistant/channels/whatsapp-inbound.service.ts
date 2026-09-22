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
    if (!(await this.isEnabled())) return;
    const session = this.session;
    if (
      event.tenantId !== session.tenantId ||
      event.branchId !== session.branchId
    ) {
      return;
    }
    // Grupos, estados y difusiones: no se responden. Un agente contestando en
    // un grupo es ruido garantizado.
    if (!event.chatId.endsWith('@c.us')) return;

    const phone = this.phoneOf(event.chatId);
    if (!phone) return;

    try {
      if (event.fromMe) {
        await this.handleOutgoing(phone, event.body);
        return;
      }
      if (event.type !== 'chat' || !event.body.trim()) {
        // Audios, fotos y adjuntos: todavía no se saben leer. Callarse es mejor
        // que responder "no entendí" a una nota de voz.
        return;
      }

      const started = Date.now();
      const result = await this.agent.process({
        channel: AssistantChannel.WHATSAPP,
        externalUserId: phone,
        message: event.body,
      });

      if (result.action !== 'IGNORE' && result.reply) {
        await this.send(event.chatId, result.reply);
      }
      if (result.action === 'HUMAN_HANDOFF') {
        // Fase 1: queda en el log. El aviso al equipo es el paso siguiente.
        this.logger.log(`Handoff sugerido (${result.reason ?? 'sin razón'})`);
      }
      this.record(result, started);
    } catch (err) {
      // Nunca se le responde al usuario un error técnico, y nunca se tumba la
      // sesión de WhatsApp por una consulta.
      this.logger.error(
        `Fallo atendiendo un mensaje: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Un mensaje que salió de nuestra cuenta.
   *
   * Si fue el agente, se descarta. Si no, lo escribió una persona del equipo
   * —desde el celular o desde WhatsApp Web— y el agente se calla en ese chat
   * durante unas horas. Es la única heurística del módulo y es deliberadamente
   * conservadora: prefiere callarse de más.
   */
  private async handleOutgoing(phone: string, body: string): Promise<void> {
    if (this.consumeOwnSend(phone, body)) return;
    await this.conversations.markHumanTakeover(
      AssistantChannel.WHATSAPP,
      phone,
    );
    this.logger.log('Un mensaje manual tomó el chat: el agente se silencia');
  }

  private async send(chatId: string, body: string): Promise<void> {
    const { tenantId, branchId } = this.session;
    const client = this.sessions.getClient(tenantId, branchId);
    if (!client) {
      this.logger.warn('No hay cliente de WhatsApp para responder');
      return;
    }
    // Se marca ANTES de enviar: `message_create` puede llegar antes de que
    // `sendMessage` resuelva, y si no estuviera marcado el agente se tomaría a
    // sí mismo por una persona y se silenciaría solo.
    this.rememberOwnSend(this.phoneOf(chatId) ?? chatId, body);
    await client.sendMessage(chatId, body);
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

  /** '573001234567@c.us' → '573001234567'. */
  private phoneOf(chatId: string): string | null {
    try {
      return normalizePhone(chatId.split('@')[0] ?? '');
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
