export const WHATSAPP_CHANNEL = Symbol('WHATSAPP_CHANNEL');
export const EMAIL_CHANNEL = Symbol('EMAIL_CHANNEL');

export interface ChannelAttachment {
  /** URL pública del archivo (Supabase Storage). */
  url: string;
  filename: string;
  /** Solo WhatsApp: se manda como imagen con el texto de caption. */
  isImage?: boolean;
}

export interface ChannelSendInput {
  to: string;
  subject?: string;
  /** Texto plano (WhatsApp) o fallback del correo. */
  body: string;
  /** HTML del correo. Si falta, se manda `body` como texto. */
  html?: string;
  attachments?: ChannelAttachment[];
}

export interface ChannelStatus {
  ready: boolean;
  /** Detalle para la UI: número conectado, remitente configurado, o el error. */
  detail?: string;
}

/**
 * Un canal de salida de la plataforma. WhatsApp Cloud API entraría como otra
 * implementación de esto, sin tocar plantillas ni el resto del flujo.
 */
export interface IPlatformChannelSender {
  readonly channel: 'whatsapp' | 'email';
  status(): Promise<ChannelStatus>;
  send(input: ChannelSendInput): Promise<{ id: string }>;
}
