import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MessageMedia } from 'whatsapp-web.js';
import { WhatsAppSessionManager } from '../../whatsapp/whatsapp-session.manager';
import {
  PLATFORM_BRANCH_ID,
  PLATFORM_TENANT_ID,
} from '../platform-messaging.constants';
import {
  ChannelSendInput,
  ChannelStatus,
  IPlatformChannelSender,
} from './channel.interface';
import { normalizePhone } from '../phone.util';

@Injectable()
export class WhatsAppPlatformChannel implements IPlatformChannelSender {
  readonly channel = 'whatsapp' as const;
  private readonly logger = new Logger(WhatsAppPlatformChannel.name);

  constructor(private readonly sessions: WhatsAppSessionManager) {}

  // El estado se lee de memoria, sin I/O; devuelve Promise solo para cumplir la
  // interfaz común con el canal de correo, que sí consulta la DB.
  status(): Promise<ChannelStatus> {
    const state = this.sessions.getStatus(
      PLATFORM_TENANT_ID,
      PLATFORM_BRANCH_ID,
    );
    return Promise.resolve({
      ready: state.status === 'ready',
      detail: state.phoneNumber ?? state.error ?? state.status,
      state: state.status,
      qr: state.qr,
      slots: this.sessions.getCapacity(),
    });
  }

  async send(input: ChannelSendInput): Promise<{ id: string }> {
    const client = this.sessions.getClient(
      PLATFORM_TENANT_ID,
      PLATFORM_BRANCH_ID,
    );
    const ready = await this.sessions.isReady(
      PLATFORM_TENANT_ID,
      PLATFORM_BRANCH_ID,
    );
    if (!ready || !client) {
      throw new ServiceUnavailableException(
        'El WhatsApp de la plataforma no está conectado. Escanea el QR en Mensajería → Canales.',
      );
    }

    const phone = normalizePhone(input.to);
    const numberId = await client.getNumberId(phone);
    if (!numberId) {
      throw new ServiceUnavailableException(
        `El número ${phone} no está registrado en WhatsApp`,
      );
    }
    const chatId = numberId._serialized;

    // Con imagen adjunta el texto viaja como caption, así llega un solo mensaje
    // con el QR y las instrucciones juntos en vez de dos sueltos.
    const image = input.attachments?.find((a) => a.isImage);
    let firstId: string | undefined;
    // Si el caption ya salió, el texto NO se repite. Se lleva aparte del id
    // porque whatsapp-web.js a veces resuelve sin `id` aunque el mensaje sí se
    // entregó: usar el id como señal hacía que el cliente recibiera el mismo
    // texto dos veces, una como caption de la imagen y otra suelto.
    let bodyDelivered = false;

    if (image) {
      const media = await this.fetchMedia(image.url, image.filename);
      if (media) {
        const sent = await client.sendMessage(chatId, media, {
          caption: input.body,
        });
        // `sendMessage` no lanzó: el caption llegó, con id o sin él.
        bodyDelivered = true;
        firstId = sent?.id?._serialized;
      }
    }

    if (!bodyDelivered) {
      // Sin imagen (o si la descarga falló) el texto sale igual: que no se caiga
      // el recordatorio por no haber podido bajar un QR.
      const sent = await client.sendMessage(chatId, input.body);
      firstId = sent?.id?._serialized;
    }

    // Los adjuntos no-imagen (el PDF del QR) van como documento aparte.
    for (const doc of input.attachments?.filter((a) => !a.isImage) ?? []) {
      const media = await this.fetchMedia(doc.url, doc.filename);
      if (media) await client.sendMessage(chatId, media);
    }

    // `'sent'` como último recurso: el mensaje salió aunque la librería no haya
    // devuelto id, y el historial necesita algo que registrar.
    return { id: firstId ?? 'sent' };
  }

  private async fetchMedia(
    url: string,
    filename: string,
  ): Promise<MessageMedia | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const mime =
        res.headers.get('content-type') ?? 'application/octet-stream';
      return new MessageMedia(mime, buffer.toString('base64'), filename);
    } catch (err) {
      this.logger.warn(
        `No se pudo adjuntar ${filename} (${url}): ${(err as Error).message}`,
      );
      return null;
    }
  }
}
