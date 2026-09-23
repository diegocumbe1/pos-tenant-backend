import { AssistantChannel } from '@prisma/client';
import { AgentIntent } from '../intents/intent-resolver.service';

export interface AgentRequest {
  channel: AssistantChannel;
  /** El interlocutor en su canal: teléfono normalizado, userId de Amazon… */
  externalUserId: string;
  message: string;
}

/**
 * Qué hacer con el mensaje. No todo mensaje entrante merece una respuesta
 * automática, y ese es justamente el punto de que esta decisión exista.
 */
export type AgentAction =
  /** Hay respuesta y es segura: se envía. */
  | 'RESPOND'
  /** Falta un dato (cuál negocio, cuál período): se pregunta. */
  | 'CLARIFY'
  /** No es del agente: lo atiende una persona. */
  | 'HUMAN_HANDOFF'
  /** No hay nada que contestar: chat tomado por el equipo, eco, ruido. */
  | 'IGNORE';

export interface AgentResult {
  action: AgentAction;
  /** Texto a enviar. Vacío en IGNORE. */
  reply?: string;
  /** Por qué se escaló o se ignoró. Para logs, nunca se le manda al usuario. */
  reason?: string;
  context: {
    personId: string | null;
    tenantId: string | null;
    intent: AgentIntent;
    /** Código de la vertical del negocio consultado. Lo exige la telemetría. */
    vertical?: string | null;
    /** Rol con el que se respondió, que no siempre es el mismo del teléfono. */
    roleCode?: string | null;
    /**
     * De dónde salió la identidad: `USER` es el único que da acceso.
     *
     * Se propaga para el diagnóstico de la consola. Sin esto, "te saludó por tu
     * nombre pero te trató como desconocido" no tiene explicación visible: el
     * nombre pudo salir de un contacto de cobro o de un cliente de un negocio,
     * y ninguno de los dos es una cuenta.
     */
    identity?: string;
  };
}
