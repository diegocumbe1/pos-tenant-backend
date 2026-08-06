import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  ChannelSendInput,
  ChannelStatus,
  IPlatformChannelSender,
} from './channel.interface';
import { MessagingSettingsService } from '../services/messaging-settings.service';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

interface ResendPayload {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  reply_to?: string;
  attachments?: Array<{ filename: string; content: string }>;
}

/**
 * Correo saliente vía Resend (API HTTP).
 *
 * Se usa HTTP y no SMTP a propósito: los PaaS suelen bloquear los puertos SMTP
 * salientes, y ahí el fallo aparece recién en producción. Tampoco hace falta
 * dependencia nueva — Node 22 trae `fetch`.
 *
 * La configuración (API key, remitente, reply-to) vive en la DB y se edita desde
 * la consola: rotar la key o cambiar el remitente no debe requerir un redeploy.
 * Las variables de entorno quedan solo como respaldo para arranques donde la
 * fila de settings aún no existe.
 *
 * El dominio del remitente debe estar verificado (SPF + DKIM) o los avisos de
 * cobro caen en spam.
 */
@Injectable()
export class EmailPlatformChannel implements IPlatformChannelSender {
  readonly channel = 'email' as const;
  private readonly logger = new Logger(EmailPlatformChannel.name);

  constructor(private readonly settings: MessagingSettingsService) {}

  /** Config efectiva: manda la DB; el entorno solo cubre lo que falte. */
  private async config() {
    const row = await this.settings.get();
    const address = row.fromEmail || process.env.MAIL_FROM || '';
    const name = row.fromName || process.env.MAIL_FROM_NAME || '';
    return {
      apiKey: row.resendApiKey || process.env.RESEND_API_KEY || '',
      from: address ? (name ? `${name} <${address}>` : address) : '',
      replyTo: row.replyTo || process.env.MAIL_REPLY_TO || '',
      enabled: row.emailEnabled,
    };
  }

  /**
   * ¿Están las credenciales completas? Deliberadamente ignora `emailEnabled`:
   * el envío de prueba tiene que funcionar ANTES de encender el canal, que es
   * el orden natural (configuro → pruebo → enciendo). Exigir el canal prendido
   * para poder probarlo obliga a encenderlo a ciegas.
   */
  private async configStatus(): Promise<ChannelStatus> {
    const { apiKey, from } = await this.config();
    if (!apiKey) return { ready: false, detail: 'Falta la API key de Resend' };
    if (!from) return { ready: false, detail: 'Falta el correo remitente' };
    return { ready: true, detail: from };
  }

  /** Estado del canal para la consola y para los envíos reales. */
  async status(): Promise<ChannelStatus> {
    const config = await this.configStatus();
    if (!config.ready) return config;
    const { enabled } = await this.config();
    if (!enabled) {
      return { ready: false, detail: `Canal apagado · ${config.detail}` };
    }
    return config;
  }

  /** Envío de prueba: solo exige credenciales, no que el canal esté activo. */
  async sendTest(input: ChannelSendInput): Promise<{ id: string }> {
    return this.dispatch(input, await this.configStatus());
  }

  async send(input: ChannelSendInput): Promise<{ id: string }> {
    return this.dispatch(input, await this.status());
  }

  private async dispatch(
    input: ChannelSendInput,
    { ready, detail }: ChannelStatus,
  ): Promise<{ id: string }> {
    const { apiKey, from, replyTo } = await this.config();
    if (!ready) {
      throw new ServiceUnavailableException(
        `El correo no está configurado: ${detail}`,
      );
    }

    const payload: ResendPayload = {
      from,
      to: [input.to],
      subject: input.subject ?? 'Mensaje de Lynko',
      html: input.html,
      text: input.body,
    };
    if (replyTo) payload.reply_to = replyTo;

    const attachments = await this.buildAttachments(input);
    if (attachments.length > 0) payload.attachments = attachments;

    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ServiceUnavailableException(
        `Resend respondió ${res.status}: ${detail.slice(0, 300)}`,
      );
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { id: data.id ?? 'sent' };
  }

  /**
   * El QR se adjunta además de referenciarse por URL en el HTML: muchos
   * clientes de correo bloquean imágenes remotas hasta que el usuario acepta, y
   * sin el adjunto el cliente se queda sin forma de pagar.
   */
  private async buildAttachments(input: ChannelSendInput) {
    const out: Array<{ filename: string; content: string }> = [];
    for (const attachment of input.attachments ?? []) {
      try {
        const res = await fetch(attachment.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        out.push({
          filename: attachment.filename,
          content: buffer.toString('base64'),
        });
      } catch (err) {
        this.logger.warn(
          `No se pudo adjuntar ${attachment.filename}: ${(err as Error).message}`,
        );
      }
    }
    return out;
  }
}
