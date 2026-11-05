import { randomInt } from 'crypto';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import {
  AgentProposal,
  AgentProposalStatus,
  AssistantChannel,
  Prisma,
} from '@prisma/client';
import { MessagingSettingsService } from '../../platform-messaging/services/messaging-settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AssistantScopeService } from '../assistant-scope.service';
import { AgentAction } from '../agent/agent.types';
import { AgentIntent } from '../intents/intent-resolver.service';
import { AssistantQuotaService } from '../telemetry/assistant-quota.service';
import { ExpenseFlow } from './expense.flow';
import { normalizeCommand, parseProposalCommand } from './proposal-commands';
import {
  FlowPayload,
  FlowStep,
  ProposalFlow,
  ProposalScope,
  hasPermission,
} from './proposal-flow';
import { RetailSaleFlow } from './retail-sale.flow';

export type { ProposalScope } from './proposal-flow';

export interface ProposalReply {
  reply: string;
  action: AgentAction;
  intent: AgentIntent;
  level?: 'PREPARE' | 'EXECUTE';
  scope?: ProposalScope;
}

interface Identified {
  channel: AssistantChannel;
  externalUserId: string;
}

const TTL_MS = 10 * 60_000;

const clockCO = (date: Date) =>
  date.toLocaleTimeString('es-CO', {
    timeZone: 'America/Bogota',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

const who2 = ({ channel, externalUserId }: Identified) => ({
  channel,
  externalUserId,
});

const toJson = (payload: FlowPayload) =>
  payload as unknown as Prisma.InputJsonValue;

/**
 * Lo que el agente propone y una persona aprueba.
 *
 * Tres reglas sostienen todo esto:
 *  - Conocer el código no autoriza nada: al confirmar se vuelve a comprobar el
 *    negocio, la cuenta que lo pidió y el permiso, igual que `@RequirePermissions`.
 *  - El código se reclama en la base ANTES de ejecutar. Repetir un mensaje no
 *    puede crear dos registros; lo peor que puede pasar es que no se cree ninguno.
 *  - Se ejecuta con el mismo servicio de la pantalla, sin un camino "para el agente".
 *
 * Qué preguntar y cómo ejecutar lo sabe cada `ProposalFlow`; aquí no se habla de
 * gastos ni de ventas.
 */
@Injectable()
export class AgentProposalsService {
  private readonly logger = new Logger('AgentProposals');
  private readonly flows: Record<string, ProposalFlow<any>>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AssistantScopeService,
    private readonly settings: MessagingSettingsService,
    private readonly quota: AssistantQuotaService,
    expense: ExpenseFlow,
    retailSale: RetailSaleFlow,
  ) {
    this.flows = { [expense.kind]: expense, [retailSale.kind]: retailSale };
  }

  /**
   * Solo por WhatsApp y con el interruptor del backoffice. Alexa no entra aquí:
   * la voz nunca confirma. Si no se puede leer el interruptor, queda apagado.
   */
  async enabled(channel: AssistantChannel): Promise<boolean> {
    if (channel !== AssistantChannel.WHATSAPP) return false;
    try {
      return (await this.settings.get()).agentCaptureEnabled;
    } catch {
      return false;
    }
  }

  /** Atiende el mensaje si es una orden sobre un borrador o responde a una pregunta. */
  async handle(input: {
    channel: AssistantChannel;
    externalUserId: string;
    message: string;
    intent: AgentIntent;
    scopes: ProposalScope[];
  }): Promise<ProposalReply | null> {
    const command = parseProposalCommand(input.message);
    const who = {
      channel: input.channel,
      externalUserId: input.externalUserId,
    };

    switch (command?.type) {
      case 'confirm':
        return this.confirm(who, command.code, input.scopes);
      case 'reject':
        return this.reject(who, command.code);
      case 'inspect':
        return this.inspect(who, command.code);
      case 'list':
        return this.list(who, input.scopes);
      case 'help':
        return this.say(
          [
            'Esto puedes registrar por aquí. Si falta algo, te pregunto, y antes de registrar te muestro un borrador para que lo confirmes.',
            '',
            '*Ventas* (en tiendas):',
            'vendí [cantidad] [producto] a [cliente] por [medio]',
            'Ejemplo: vendí 2 mantequillas de coco a Laura por nequi',
            'También: "queda debiendo", "dejó 20 mil", "sepárale" o "se entrega luego".',
            '',
            '*Gastos*:',
            'gasté [monto] en [concepto] de [cuenta]',
            'Ejemplo: gasté 50 mil en domicilios de efectivo',
          ].join('\n'),
        );
      case 'unsupported':
        return this.say(
          `Todavía no registro ${command.what === 'cita' ? 'citas' : `un ${command.what}`} por aquí: hazlo desde la app. Lo que sí puedo registrar son ventas y gastos.`,
        );
      case 'bare_yes': {
        const handled = await this.bareYes(who, input.scopes);
        if (handled) return handled;
        break;
      }
      case 'bare_no': {
        // "¿Dejó abono?" "No". Eso responde la pregunta, no cancela el borrador.
        if (await this.noIsAnAnswer(who, input.message)) {
          return this.answer(input, false);
        }
        const handled = await this.bareNo(who);
        if (handled) return handled;
        break;
      }
    }

    return this.answer(input, !!command);
  }

  /** Arranca un borrador desde la frase: entiende lo que pueda y pregunta el resto. */
  async start(
    kind: string,
    who: Identified & { message: string },
    scope: ProposalScope,
  ): Promise<ProposalReply> {
    const flow = this.flows[kind];
    if (scope.actor.isPlatformAdmin) {
      return this.say(
        'Una cuenta de plataforma no registra datos en los negocios. Hazlo con una cuenta del negocio.',
        scope,
      );
    }
    const refused = flow.guard(scope);
    if (refused) return this.say(refused, scope);
    if (!(await hasPermission(this.scope, scope, flow.permission))) {
      return this.say(flow.permissionDenied, scope);
    }
    await this.quota.assertAvailable(scope.business.id, scope.business.name);

    // Un borrador a medias es uno solo: empezar otro descarta el anterior.
    await this.prisma.agentProposal.updateMany({
      where: { ...who2(who), status: AgentProposalStatus.COLLECTING },
      data: { status: AgentProposalStatus.REJECTED },
    });

    const payload = flow.start(who.message) as FlowPayload;
    const row = await this.prisma.agentProposal.create({
      data: {
        ...who2(who),
        tenantId: scope.business.id,
        requestedById: scope.actor.id,
        kind,
        payload: toJson(payload),
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });
    return this.advance(row, flow, payload, scope);
  }

  // ─── Preguntar lo que falta ───────────────────────────────────────────────

  private async answer(
    input: Identified & {
      message: string;
      intent: AgentIntent;
      scopes: ProposalScope[];
    },
    isCommand: boolean,
  ): Promise<ProposalReply | null> {
    const row = await this.collecting(input);
    if (!row) return null;

    const scope = input.scopes.find(
      (s) => s.business.id === row.tenantId && s.actor.id === row.requestedById,
    );
    if (!scope) {
      await this.setStatus(row.id, AgentProposalStatus.REJECTED);
      return null;
    }

    const flow = this.flowOf(row);
    const payload = row.payload as unknown as FlowPayload;
    const next = isCommand
      ? null
      : (flow.applyAnswer(
          payload,
          input.message,
          input.intent,
        ) as FlowPayload | null);
    if (next) return this.advance(row, flow, next, scope);

    // Es otra pregunta ("¿cuánto vendí hoy?"): se contesta y el borrador sigue
    // abierto. Si no es nada conocido, se repite lo que se preguntó.
    const unrelated = ![
      'unknown',
      'select_option',
      'welcome',
      'options',
    ].includes(input.intent);
    if (unrelated && !isCommand) return null;
    return this.advance(row, flow, payload, scope);
  }

  /** Pregunta lo siguiente que falta o, si no falta nada, arma el borrador. */
  private async advance(
    row: AgentProposal,
    flow: ProposalFlow<any>,
    payload: FlowPayload,
    scope: ProposalScope,
  ): Promise<ProposalReply> {
    const step = (await flow.next(
      payload,
      scope,
      row.branchId,
    )) as FlowStep<FlowPayload>;

    if (step.type === 'abort') {
      await this.setStatus(row.id, AgentProposalStatus.REJECTED);
      return this.say(step.text, scope);
    }
    if (step.type === 'ask') {
      await this.prisma.agentProposal.update({
        where: { id: row.id },
        data: {
          branchId: step.branchId,
          payload: toJson(step.payload),
          expiresAt: new Date(Date.now() + TTL_MS),
        },
      });
      return {
        reply: step.text,
        action: 'CLARIFY',
        intent: flow.intent,
        scope,
      };
    }

    const expiresAt = new Date(Date.now() + TTL_MS);
    const code = await this.newCode(row);
    const what = flow.summary(step.payload);
    const preview = [
      ...step.lines,
      '',
      `Código de este borrador: *${code}*`,
      `Solo sirve para ${flow.words.this} ${what}.`,
      `Vence a las ${clockCO(expiresAt)}`,
      '',
      `Responde SI ${code} para ${flow.words.verb}`,
      `Responde NO ${code} para cancelarlo`,
    ].join('\n');
    await this.prisma.agentProposal.update({
      where: { id: row.id },
      data: {
        branchId: step.branchId,
        payload: toJson(step.payload),
        status: AgentProposalStatus.PENDING,
        confirmCode: code,
        preview,
        expiresAt,
      },
    });
    return {
      reply: preview,
      action: 'CLARIFY',
      intent: flow.intent,
      level: 'PREPARE',
      scope,
    };
  }

  // ─── Confirmar, cancelar y consultar ──────────────────────────────────────

  private async confirm(
    who: Identified,
    code: string,
    scopes: ProposalScope[],
  ): Promise<ProposalReply> {
    const row = await this.byCode(who, code);
    if (!row) return this.unknownCode(who, code, scopes);
    if (row.status !== AgentProposalStatus.PENDING) {
      return this.say(this.deadText(row, code));
    }
    if (row.expiresAt <= new Date()) {
      await this.setStatus(row.id, AgentProposalStatus.EXPIRED);
      return this.say(
        this.deadText({ ...row, status: AgentProposalStatus.EXPIRED }, code),
      );
    }

    const flow = this.flowOf(row);
    const what = this.summaryOf(row);
    const scope = scopes.find(
      (s) => s.business.id === row.tenantId && s.actor.id === row.requestedById,
    );
    if (!scope) {
      return this.say(
        `El borrador ${code} (${what}) lo pidió otra cuenta o ya no tienes acceso a ese negocio. No se registró nada.`,
      );
    }
    const allowedBranch =
      scope.actor.isRoot ||
      (!!row.branchId && scope.actor.accessibleBranches.includes(row.branchId));
    if (
      !allowedBranch ||
      !(await hasPermission(this.scope, scope, flow.permission))
    ) {
      return this.say(
        `Tu usuario no tiene permiso para registrar el borrador ${code} (${what}). No se registró nada.`,
        scope,
      );
    }

    // Se reclama antes de ejecutar: quien llegue segundo no encuentra nada.
    const now = new Date();
    const claimed = await this.prisma.agentProposal.updateMany({
      where: {
        id: row.id,
        status: AgentProposalStatus.PENDING,
        expiresAt: { gt: now },
      },
      data: {
        status: AgentProposalStatus.CONFIRMED,
        decidedById: scope.actor.id,
        decidedAt: now,
      },
    });
    if (!claimed.count) {
      const fresh = await this.byCode(who, code);
      return this.say(this.deadText(fresh ?? row, code), scope);
    }

    try {
      const done = await flow.execute(
        row.payload,
        scope,
        row.branchId as string,
        code,
        { channel: row.channel, proposalId: row.id },
      );
      await this.prisma.agentProposal.update({
        where: { id: row.id },
        data: { resultRef: done.resultRef },
      });
      return { ...this.say(done.reply, scope), level: 'EXECUTE' };
    } catch (error) {
      const message =
        error instanceof HttpException
          ? error.message
          : 'No pude guardarlo en este momento.';
      if (!(error instanceof HttpException)) {
        this.logger.error(
          `Proposal ${row.id} failed: ${(error as Error)?.message}`,
        );
      }
      await this.prisma.agentProposal.update({
        where: { id: row.id },
        data: { status: AgentProposalStatus.FAILED, errorMessage: message },
      });
      return this.say(
        `El borrador ${code} (${what}) no se registró: ${message}`,
        scope,
      );
    }
  }

  private async reject(who: Identified, code: string): Promise<ProposalReply> {
    const row = await this.byCode(who, code);
    if (!row) return this.say(`No tengo un borrador con el código ${code}.`);
    if (row.status !== AgentProposalStatus.PENDING) {
      return this.say(this.deadText(row, code));
    }
    await this.setStatus(row.id, AgentProposalStatus.REJECTED);
    return this.say(
      `Cancelé el borrador ${code}: ${this.summaryOf(row)}. No se registró nada.`,
    );
  }

  private async inspect(who: Identified, code: string): Promise<ProposalReply> {
    const row = await this.byCode(who, code);
    if (!row) return this.say(`No tengo un borrador con el código ${code}.`);
    if (
      row.status === AgentProposalStatus.PENDING &&
      row.expiresAt > new Date()
    ) {
      return this.say(row.preview ?? this.summaryOf(row));
    }
    return this.say(this.deadText(row, code));
  }

  private async list(
    who: Identified,
    scopes: ProposalScope[],
  ): Promise<ProposalReply> {
    const open = await this.pending(who);
    return this.say(
      open.length
        ? this.listText(open, scopes)
        : 'No tienes borradores abiertos.',
    );
  }

  private async bareYes(
    who: Identified,
    scopes: ProposalScope[],
  ): Promise<ProposalReply | null> {
    const open = await this.pending(who);
    if (!open.length) return null;
    if (open.length > 1) return this.say(this.listText(open, scopes));
    const [row] = open;
    return this.say(
      `¿Confirmas ${this.flowOf(row).words.the} ${this.summaryOf(row)}? Responde SI ${row.confirmCode}.`,
    );
  }

  private async noIsAnAnswer(
    who: Identified,
    message: string,
  ): Promise<boolean> {
    if (normalizeCommand(message) !== 'no') return false;
    const row = await this.collecting(who);
    if (!row) return false;
    const { awaiting } = row.payload as unknown as FlowPayload;
    return !!awaiting && !!this.flowOf(row).noAnswers?.includes(awaiting);
  }

  private async bareNo(who: Identified): Promise<ProposalReply | null> {
    const row = await this.collecting(who);
    if (row) {
      await this.setStatus(row.id, AgentProposalStatus.REJECTED);
      return this.say('Listo, lo dejé así. No se registró nada.');
    }
    const open = await this.pending(who);
    if (!open.length) return null;
    return this.say(
      [
        '¿Cuál quieres cancelar? Responde NO y el código:',
        ...open.map((r) => `• NO ${r.confirmCode}: ${this.summaryOf(r)}`),
      ].join('\n'),
    );
  }

  private async unknownCode(
    who: Identified,
    code: string,
    scopes: ProposalScope[],
  ): Promise<ProposalReply> {
    const open = await this.pending(who);
    return this.say(
      [
        `No tengo un borrador con el código ${code}.`,
        ...(open.length ? [this.listText(open, scopes)] : []),
      ].join('\n'),
    );
  }

  // ─── Textos ───────────────────────────────────────────────────────────────

  private summaryOf(row: AgentProposal): string {
    return this.flowOf(row).summary(row.payload);
  }

  private deadText(row: AgentProposal, code: string): string {
    const what = this.summaryOf(row);
    switch (row.status) {
      case AgentProposalStatus.CONFIRMED:
        return `El borrador ${code} (${what}) ya se registró. No creé otro.`;
      case AgentProposalStatus.REJECTED:
        return `El borrador ${code} (${what}) ya estaba cancelado. No se registró nada.`;
      case AgentProposalStatus.FAILED:
        return `El borrador ${code} (${what}) no se pudo registrar: ${row.errorMessage ?? 'falló al guardarlo'}. Escríbemelo de nuevo si lo quieres intentar.`;
      default:
        return `El borrador ${code} (${what}) venció y no se registró. Escríbemelo de nuevo si lo quieres registrar.`;
    }
  }

  private listText(rows: AgentProposal[], scopes: ProposalScope[]): string {
    const nameOf = (tenantId: string) =>
      scopes.find((s) => s.business.id === tenantId)?.business.name;
    return [
      'Tienes estos borradores abiertos:',
      ...rows.map((row) => {
        const name = nameOf(row.tenantId);
        return `• ${row.confirmCode}: ${this.summaryOf(row)}${name ? ` en ${name}` : ''}`;
      }),
      'Responde SI o NO con el código del que quieras.',
    ].join('\n');
  }

  private say(reply: string, scope?: ProposalScope): ProposalReply {
    return { reply, action: 'RESPOND', intent: 'proposal_command', scope };
  }

  // ─── Datos ────────────────────────────────────────────────────────────────

  private flowOf(row: AgentProposal): ProposalFlow<any> {
    return this.flows[row.kind];
  }

  private async collecting(who: Identified): Promise<AgentProposal | null> {
    const row = await this.prisma.agentProposal.findFirst({
      where: { ...who2(who), status: AgentProposalStatus.COLLECTING },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return null;
    if (row.expiresAt <= new Date()) {
      await this.setStatus(row.id, AgentProposalStatus.EXPIRED);
      return null;
    }
    return row;
  }

  private pending(who: Identified): Promise<AgentProposal[]> {
    return this.prisma.agentProposal.findMany({
      where: {
        ...who2(who),
        status: AgentProposalStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** El más reciente: un código puede volver a salir cuando el anterior ya murió. */
  private byCode(who: Identified, code: string): Promise<AgentProposal | null> {
    return this.prisma.agentProposal.findFirst({
      where: { ...who2(who), confirmCode: code },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async setStatus(
    id: string,
    status: AgentProposalStatus,
  ): Promise<void> {
    await this.prisma.agentProposal.update({ where: { id }, data: { status } });
  }

  /** Aleatorio y sin repetir entre los borradores vigentes de esta persona. */
  private async newCode(row: AgentProposal): Promise<string> {
    const taken = new Set(
      (
        await this.pending({
          channel: row.channel,
          externalUserId: row.externalUserId,
        })
      ).map((r) => r.confirmCode),
    );
    let code: string;
    do {
      code = String(randomInt(1000, 10000));
    } while (taken.has(code));
    return code;
  }
}
