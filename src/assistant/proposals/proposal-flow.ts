import { AgentIntent } from '../intents/intent-resolver.service';
import { AssistantScopeService, BusinessRef } from '../assistant-scope.service';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import { CaptureOrigin } from '../../common/capture-origin';
import { normalizeCommand } from './proposal-commands';

export interface ProposalScope {
  business: BusinessRef;
  actor: AuthenticatedUser;
}

export interface Option {
  value: string;
  label: string;
}

/** Lo que todo borrador recuerda de la conversación. */
export interface FlowPayload {
  awaiting?: string;
  options?: Option[];
  /** Se dice una vez, antes de la siguiente pregunta. */
  notice?: string;
}

export type FlowStep<P> =
  | { type: 'ask'; payload: P; branchId: string | null; text: string }
  /** No hay cómo seguir: se dice por qué y el borrador se cierra. */
  | { type: 'abort'; text: string }
  | { type: 'ready'; payload: P; branchId: string; lines: string[] };

export interface FlowExecution {
  resultRef: string;
  reply: string;
}

/**
 * Una operación que Lynko puede preparar. El motor (`AgentProposalsService`) se
 * encarga del código, los permisos y la confirmación; el flujo solo sabe qué
 * preguntar y con qué servicio existente se ejecuta.
 *
 * Añadir una operación es escribir uno de estos, no tocar el motor.
 */
export interface ProposalFlow<P extends FlowPayload = FlowPayload> {
  readonly kind: string;
  readonly intent: AgentIntent;
  /** El mismo permiso que exige el controlador de la pantalla. */
  readonly permission: string;
  readonly permissionDenied: string;
  /** "este gasto" / "esta venta", "registrarlo" / "registrarla", "el" / "la". */
  readonly words: { this: string; verb: string; the: string };
  /** Preguntas donde "no" es una respuesta y no la orden de dejarlo. */
  readonly noAnswers?: string[];
  /** Null si puede arrancar; si no, por qué. */
  guard(scope: ProposalScope): string | null;
  start(message: string): P;
  /** La respuesta aplicada, o null si no respondió lo que se preguntó. */
  applyAnswer(payload: P, message: string, intent: AgentIntent): P | null;
  next(
    payload: P,
    scope: ProposalScope,
    branchId: string | null,
  ): Promise<FlowStep<P>>;
  summary(payload: P): string;
  /** Con el mismo servicio de la pantalla. Lo que lance se le dice a la persona. */
  execute(
    payload: P,
    scope: ProposalScope,
    branchId: string,
    code: string,
    /** Se pasa al servicio: el registro tiene que decir por dónde entró. */
    origin: CaptureOrigin,
  ): Promise<FlowExecution>;
}

/** Prepara una pregunta: guarda qué se espera y deja las opciones numeradas. */
export function askStep<P extends FlowPayload>(
  payload: P,
  branchId: string | null,
  awaiting: string,
  text: string,
  options?: Option[],
): FlowStep<P> {
  const shown = options ?? payload.options;
  const list = shown?.length
    ? `\n${shown.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}`
    : '';
  const notice = payload.notice ? `${payload.notice}\n` : '';
  return {
    type: 'ask',
    branchId,
    payload: { ...payload, awaiting, options: shown, notice: undefined },
    text: `${notice}${text}${list}\n\nPara dejarlo, responde NO.`,
  };
}

/** Por número del menú o por el nombre, si solo coincide uno. */
export function pickOption(message: string, options: Option[]): Option | null {
  const text = normalizeCommand(message);
  const digit = /^(\d{1,2})[).]?$/.exec(text);
  if (digit) return options[Number(digit[1]) - 1] ?? null;
  if (!text) return null;
  const exact = options.filter((o) => normalizeCommand(o.label) === text);
  if (exact.length === 1) return exact[0];
  const partial = options.filter((o) =>
    normalizeCommand(o.label).includes(text),
  );
  return partial.length === 1 ? partial[0] : null;
}

/**
 * Cuando se espera un texto libre casi cualquier cosa vale, así que el lexicón no
 * sirve de filtro ("domicilio" también parece una consulta de entregas). Solo se
 * descarta lo que claramente es otra cosa.
 */
export function isOtherQuestion(message: string, intent: AgentIntent): boolean {
  return (
    message.includes('?') ||
    /^(?:cuanto|cuantos|cuantas|como|que|quien|cual)\b/.test(
      normalizeCommand(message),
    ) ||
    intent === 'human_handoff' ||
    intent === 'goodbye' ||
    intent === 'welcome'
  );
}

/** Las sedes del negocio en las que esta cuenta puede trabajar. */
export type BranchLookup = (
  scope: ProposalScope,
) => Promise<{ id: string; name: string }[]>;

/** Misma regla que `@RequirePermissions`, sin lanzar. */
export async function hasPermission(
  scopes: AssistantScopeService,
  scope: ProposalScope,
  code: string,
): Promise<boolean> {
  const ctx = await scopes.contextFor(scope.actor, scope.business.id);
  try {
    scopes.assertPermission(ctx, code);
    return true;
  } catch {
    return false;
  }
}
