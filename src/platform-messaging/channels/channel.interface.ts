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
  /**
   * Estado crudo de la sesión de WhatsApp ('qr_ready', 'authenticated', …).
   * La consola lo usa para saber qué mostrar mientras se empareja.
   */
  state?: string;
  /**
   * QR de emparejamiento como data URL. Viaja en el estado —y no por SSE—
   * porque `EventSource` no puede mandar el header Authorization y estos
   * endpoints van detrás de JwtAuthGuard; la consola ya hace polling.
   */
  qr?: string;
  /**
   * Solo WhatsApp: cupos de sesión ocupados / disponibles. Cada sesión es un
   * Chromium, por eso hay tope (`WA_MAX_ACTIVE_SESSIONS`). Si están llenos, el
   * pareo falla con 409 y esto permite decirlo antes de intentarlo.
   */
  slots?: { active: number; max: number };
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
