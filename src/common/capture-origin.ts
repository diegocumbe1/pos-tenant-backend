import { AssistantChannel } from '@prisma/client';

/** Por dónde entró un registro que no se hizo en la pantalla. */
export interface CaptureOrigin {
  channel: AssistantChannel;
  /** El borrador de `agent_proposals` que lo originó. */
  proposalId: string;
}

export const CAPTURE_CHANNEL_LABEL: Record<AssistantChannel, string> = {
  WHATSAPP: 'WhatsApp',
  ALEXA: 'Alexa',
  WEB: 'el chat de Lynko',
};
