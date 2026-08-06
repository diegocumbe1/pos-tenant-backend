import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  ChannelSendInput,
  ChannelStatus,
  IPlatformChannelSender,
} from './channel.interface';

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
 * Env: RESEND_API_KEY, MAIL_FROM, MAIL_FROM_NAME, MAIL_REPLY_TO.
 * El dominio del remitente debe estar verificado (SPF + DKIM) o los avisos de
 * cobro caen en spam.
 */
@Injectable()
export class EmailPlatformChannel implements IPlatformChannelSender {
  readonly channel = 'email' as const;
  private readonly logger = new Logger(EmailPlatformChannel.name);

  private get apiKey() {
    return process.env.RESEND_API_KEY ?? '';
  }

  private get from() {
    const address = process.env.MAIL_FROM ?? '';
    const name = process.env.MAIL_FROM_NAME;
    if (!address) return '';
    return name ? `${name} <${address}>` : address;
  }

  async status(): Promise<ChannelStatus> {
    if (!this.apiKey) {
      return { ready: false, detail: 'Falta RESEND_API_KEY' };
    }
    if (!this.from) {
      return { ready: false, detail: 'Falta MAIL_FROM' };
    }
    return { ready: true, detail: this.from };
  }

  async send(input: ChannelSendInput): Promise<{ id: string }> {
    const { ready, detail } = await this.status();
    if (!ready) {
      throw new ServiceUnavailableException(
        `El correo no está configurado: ${detail}`,
      );
    }

    const payload: ResendPayload = {
      from: this.from,
      to: [input.to],
      subject: input.subject ?? 'Mensaje de Lynko',
      html: input.html,
      text: input.body,
    };
    if (process.env.MAIL_REPLY_TO) payload.reply_to = process.env.MAIL_REPLY_TO;

    const attachments = await this.buildAttachments(input);
    if (attachments.length > 0) payload.attachments = attachments;

    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
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
