import { Injectable } from '@nestjs/common';
import {
  AssistantChannel,
  AssistantConversation,
  AssistantConversationMode,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Lo que el agente quiere recordar del turno que acaba de responder. */
export interface ConversationPatch {
  personId?: string | null;
  tenantId?: string | null;
  lastIntent?: string | null;
  /** Valores normalizados (`{ period: 'yesterday' }`), nunca frases. */
  lastSlots?: Record<string, string> | null;
  /** Menú numerado que se ofreció, para poder mapear un "2" en el turno siguiente. */
  lastOptions?: { value: string; label: string }[] | null;
  greeted?: boolean;
  repliedByAgent?: boolean;
}

export interface ConversationState {
  row: AssistantConversation | null;
  /** Nadie ha escrito en horas: toca volver a presentarse. */
  stale: boolean;
  /** Una persona del equipo tomó el chat y el agente debe callarse. */
  humanActive: boolean;
}

const hoursEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * El contexto conversacional: quién escribe, de qué negocio hablamos y qué se
 * preguntó la última vez.
 *
 * Es una fila por (canal, interlocutor) en Postgres y no una caché en memoria
 * porque el backend se reinicia en cada despliegue, y perder el contexto
 * significa volver a saludar a alguien a mitad de conversación. No hace falta
 * Redis: se lee y se escribe una vez por mensaje.
 *
 * Lo que NO guarda: el texto de los mensajes. Para continuar una conversación
 * basta con el intent y sus parámetros; guardar las frases sería acumular datos
 * sensibles de negocios ajenos sin necesidad.
 */
@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  private get timeoutHours(): number {
    return hoursEnv('WHATSAPP_CONVERSATION_TIMEOUT_HOURS', 24);
  }

  private get takeoverHours(): number {
    return hoursEnv('WA_AGENT_HUMAN_TAKEOVER_HOURS', 4);
  }

  async load(
    channel: AssistantChannel,
    externalUserId: string,
  ): Promise<ConversationState> {
    const row = await this.prisma.assistantConversation.findUnique({
      where: { channel_externalUserId: { channel, externalUserId } },
    });
    if (!row) return { row: null, stale: true, humanActive: false };

    const idleMs = Date.now() - row.lastInteractionAt.getTime();
    return {
      row,
      // Sin saludo previo también cuenta como conversación nueva: la fila pudo
      // crearse por un mensaje que se ignoró.
      stale: !row.greetedAt || idleMs >= this.timeoutHours * 3_600_000,
      humanActive:
        row.mode === AssistantConversationMode.HUMAN ||
        (row.mode === AssistantConversationMode.HYBRID &&
          !!row.humanTakeoverUntil &&
          row.humanTakeoverUntil.getTime() > Date.now()),
    };
  }

  async remember(
    channel: AssistantChannel,
    externalUserId: string,
    patch: ConversationPatch,
  ): Promise<void> {
    const now = new Date();
    const data: Prisma.AssistantConversationUncheckedUpdateInput = {
      lastInteractionAt: now,
    };
    if ('personId' in patch) data.personId = patch.personId ?? null;
    if ('tenantId' in patch) data.tenantId = patch.tenantId ?? null;
    if ('lastIntent' in patch) data.lastIntent = patch.lastIntent ?? null;
    if ('lastSlots' in patch) data.lastSlots = patch.lastSlots ?? Prisma.DbNull;
    if ('lastOptions' in patch)
      data.lastOptions = patch.lastOptions ?? Prisma.DbNull;
    if (patch.greeted) data.greetedAt = now;
    if (patch.repliedByAgent) data.lastAgentReplyAt = now;

    await this.prisma.assistantConversation.upsert({
      where: { channel_externalUserId: { channel, externalUserId } },
      create: {
        channel,
        externalUserId,
        personId: patch.personId ?? null,
        tenantId: patch.tenantId ?? null,
        lastIntent: patch.lastIntent ?? null,
        lastSlots: patch.lastSlots ?? Prisma.DbNull,
        lastOptions: patch.lastOptions ?? Prisma.DbNull,
        lastInteractionAt: now,
        greetedAt: patch.greeted ? now : null,
        lastAgentReplyAt: patch.repliedByAgent ? now : null,
      },
      update: data,
    });
  }

  /**
   * Alguien del equipo escribió a mano en este chat: el agente se calla.
   *
   * No es una heurística frágil. whatsapp-web.js emite `message_create` también
   * para lo que sale de NUESTRA cuenta, incluido lo que se escribe desde el
   * celular, y el agente marca sus propios envíos para no confundirse consigo
   * mismo. Lo único que se asume es que quien escribe a mano quiere atender ese
   * chat, y por eso el silencio expira solo.
   */
  async markHumanTakeover(
    channel: AssistantChannel,
    externalUserId: string,
  ): Promise<void> {
    const until = new Date(Date.now() + this.takeoverHours * 3_600_000);
    await this.prisma.assistantConversation.upsert({
      where: { channel_externalUserId: { channel, externalUserId } },
      create: { channel, externalUserId, humanTakeoverUntil: until },
      update: { humanTakeoverUntil: until },
    });
  }

  /** Opciones numeradas del turno anterior, para resolver una respuesta "2". */
  optionsOf(
    row: AssistantConversation | null,
  ): { value: string; label: string }[] {
    const raw = row?.lastOptions;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const { value, label } = item as Record<string, unknown>;
      return typeof value === 'string' && typeof label === 'string'
        ? [{ value, label }]
        : [];
    });
  }

  slotsOf(row: AssistantConversation | null): Record<string, string> {
    const raw = row?.lastSlots;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw))
      if (typeof value === 'string') out[key] = value;
    return out;
  }
}
