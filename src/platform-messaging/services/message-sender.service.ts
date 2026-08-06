import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PlatformMessageChannel,
  PlatformMessageStatus,
  PlatformPaymentMethod,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ChannelAttachment,
  EMAIL_CHANNEL,
  IPlatformChannelSender,
  WHATSAPP_CHANNEL,
} from '../channels/channel.interface';
import { MessageChannel, SendMessageDto } from '../dto/platform-messaging.dto';
import { MessagingSettingsService } from './messaging-settings.service';
import { PaymentMethodsService } from './payment-methods.service';
import { RecipientResolverService } from './recipient-resolver.service';
import { SubscriptionContextService } from './subscription-context.service';
import { TemplateRendererService } from './template-renderer.service';
import { TemplatesService } from './templates.service';

const CHANNEL_ENUM: Record<MessageChannel, PlatformMessageChannel> = {
  whatsapp: PlatformMessageChannel.WHATSAPP,
  email: PlatformMessageChannel.EMAIL,
};

export interface ChannelPreview {
  channel: MessageChannel;
  to: string | null;
  toName: string | null;
  subject?: string;
  body: string;
  /** Cuerpo HTML del correo. La UI muestra `body`; esto es lo que se envía. */
  html?: string;
  /** Datos que faltan; si trae algo, este canal no se puede enviar. */
  blockers: string[];
  attachments: ChannelAttachment[];
}

export interface SendResult {
  channel: MessageChannel;
  to: string | null;
  status: 'sent' | 'failed' | 'skipped';
  messageId?: string;
  error?: string;
}

/**
 * Arma y despacha los mensajes de plataforma.
 *
 * Es tolerante por canal a propósito: si el correo sale y WhatsApp falla, la
 * respuesta es 200 con el detalle de cada uno. Un 500 dejaría al admin sin saber
 * qué se envió y qué no, que es justo lo que no puede pasar en un cobro.
 */
@Injectable()
export class MessageSenderService {
  private readonly logger = new Logger(MessageSenderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TemplatesService,
    private readonly renderer: TemplateRendererService,
    private readonly subscriptions: SubscriptionContextService,
    private readonly recipients: RecipientResolverService,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly settings: MessagingSettingsService,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: IPlatformChannelSender,
    @Inject(EMAIL_CHANNEL) private readonly email: IPlatformChannelSender,
  ) {}

  /**
   * El recordatorio tiene dos redacciones y la elige el estado de la cuenta, no
   * el admin: si ya venció, corresponde la de mora.
   */
  async resolveTemplateKey(tenantId: string, requestedKey: string) {
    if (requestedKey !== 'payment_reminder') return requestedKey;
    const ctx = await this.subscriptions.build(tenantId);
    return ctx.overdue ? 'payment_overdue' : 'payment_reminder';
  }

  async preview(
    tenantId: string,
    templateKey: string,
    channels: MessageChannel[],
    options: { includeQr?: boolean; bodyOverride?: string } = {},
  ): Promise<{ templateKey: string; perChannel: ChannelPreview[] }> {
    const effectiveKey = await this.resolveTemplateKey(tenantId, templateKey);
    const [ctx, recipient, methods, settings] = await Promise.all([
      this.subscriptions.build(tenantId),
      this.recipients.resolve(tenantId),
      this.paymentMethods.list(false),
      this.settings.get(),
    ]);

    const baseValues: Record<string, string> = {
      ...this.subscriptions.toVariables(ctx),
      dueno: recipient.name ?? ctx.tenantName,
      firma: settings.signature ?? 'Equipo Lynko',
      medios_pago: this.paymentMethods.renderText(methods),
      llave_breb: methods.find((m) => m.kind === 'breb')?.reference ?? '',
      link_pago: methods.find((m) => m.kind === 'link')?.reference ?? '',
    };
    const htmlValues = { medios_pago: this.paymentMethods.renderHtml(methods) };

    const attachments = options.includeQr
      ? this.qrAttachments(methods.find((m) => m.isDefault) ?? methods[0])
      : [];

    const perChannel: ChannelPreview[] = [];

    for (const channel of channels) {
      const to = channel === 'whatsapp' ? recipient.whatsapp : recipient.email;
      const blockers: string[] = [...ctx.missing];
      const skipReason =
        channel === 'whatsapp'
          ? recipient.whatsappSkipReason
          : recipient.emailSkipReason;
      if (!to && skipReason) blockers.push(skipReason);

      const template = await this.templates
        .byKey(effectiveKey, CHANNEL_ENUM[channel])
        .catch((err: Error) => {
          blockers.push(err.message);
          return null;
        });

      if (!template) {
        perChannel.push({
          channel,
          to,
          toName: recipient.name,
          body: '',
          blockers,
          attachments: [],
        });
        continue;
      }

      const subject = template.subject
        ? this.renderer.render(template.subject, baseValues).text
        : undefined;

      // El texto se renderiza siempre desde la plantilla; si el admin editó el
      // cuerpo a mano, ese texto manda y el HTML se deriva de él.
      let body: string;
      let html: string | undefined;

      if (options.bodyOverride) {
        body = options.bodyOverride;
        if (channel === 'email') {
          html = this.renderer.renderHtml(options.bodyOverride, {}).html;
        }
      } else {
        const rendered = this.renderer.render(template.body, baseValues);
        body = rendered.text;
        for (const key of rendered.missing) {
          blockers.push(`falta el dato "${key}"`);
        }
        if (channel === 'email') {
          // Se re-renderiza desde la MISMA plantilla, pero con la versión HTML
          // del bloque de medios de pago (que trae el QR embebido).
          html = this.renderer.renderHtml(
            template.body,
            baseValues,
            htmlValues,
          ).html;
        }
      }

      perChannel.push({
        channel,
        to,
        toName: recipient.name,
        subject,
        body,
        html,
        blockers: [...new Set(blockers)],
        attachments,
      });
    }

    return { templateKey: effectiveKey, perChannel };
  }

  async send(
    tenantId: string,
    dto: SendMessageDto,
    actorUserId: string,
  ): Promise<{ templateKey: string; results: SendResult[] }> {
    const { templateKey, perChannel } = await this.preview(
      tenantId,
      dto.templateKey,
      dto.channels,
      { includeQr: dto.includeQr, bodyOverride: dto.bodyOverride },
    );

    const settings = await this.settings.get();
    const results: SendResult[] = [];

    for (const preview of perChannel) {
      if (preview.blockers.length > 0 || !preview.to) {
        await this.record({
          tenantId,
          templateKey,
          channel: preview.channel,
          status: PlatformMessageStatus.SKIPPED,
          to: preview.to ?? '—',
          toName: preview.toName,
          subject: preview.subject,
          body: preview.body,
          skipReason: preview.blockers.join(' · ') || 'sin destinatario',
          createdBy: actorUserId,
        });
        results.push({
          channel: preview.channel,
          to: preview.to,
          status: 'skipped',
          error: preview.blockers.join(' · ') || 'sin destinatario',
        });
        continue;
      }

      const sender =
        preview.channel === 'whatsapp' ? this.whatsapp : this.email;

      try {
        const sent = await sender.send({
          to: preview.to,
          subject:
            preview.subject ?? `Lynko · ${settings.fromName ?? 'Plataforma'}`,
          body: preview.body,
          html: preview.html,
          attachments: preview.attachments,
        });

        await this.record({
          tenantId,
          templateKey,
          channel: preview.channel,
          status: PlatformMessageStatus.SENT,
          to: preview.to,
          toName: preview.toName,
          subject: preview.subject,
          body: preview.body,
          providerId: sent.id,
          sentAt: new Date(),
          attachments: preview.attachments,
          createdBy: actorUserId,
        });
        results.push({
          channel: preview.channel,
          to: preview.to,
          status: 'sent',
          messageId: sent.id,
        });
      } catch (err) {
        const message = (err as Error).message;
        this.logger.warn(
          `Envío fallido tenant=${tenantId} canal=${preview.channel}: ${message}`,
        );
        await this.record({
          tenantId,
          templateKey,
          channel: preview.channel,
          status: PlatformMessageStatus.FAILED,
          to: preview.to,
          toName: preview.toName,
          subject: preview.subject,
          body: preview.body,
          lastError: message,
          createdBy: actorUserId,
        });
        results.push({
          channel: preview.channel,
          to: preview.to,
          status: 'failed',
          error: message,
        });
      }
    }

    return { templateKey, results };
  }

  history(tenantId?: string, take = 50) {
    return this.prisma.platformMessage.findMany({
      where: tenantId ? { tenantId } : {},
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async channelStatus() {
    const [whatsapp, email] = await Promise.all([
      this.whatsapp.status(),
      this.email.status(),
    ]);
    return { whatsapp, email };
  }

  private qrAttachments(method?: PlatformPaymentMethod): ChannelAttachment[] {
    if (!method) return [];
    const out: ChannelAttachment[] = [];
    if (method.qrImageUrl) {
      out.push({
        url: method.qrImageUrl,
        filename: 'qr-pago.webp',
        isImage: true,
      });
    }
    if (method.qrPdfUrl) {
      out.push({ url: method.qrPdfUrl, filename: 'qr-pago.pdf' });
    }
    return out;
  }

  private record(input: {
    tenantId: string;
    templateKey: string;
    channel: MessageChannel;
    status: PlatformMessageStatus;
    to: string;
    toName: string | null;
    subject?: string;
    body: string;
    providerId?: string;
    sentAt?: Date;
    lastError?: string;
    skipReason?: string;
    attachments?: ChannelAttachment[];
    createdBy: string;
  }) {
    return this.prisma.platformMessage.create({
      data: {
        tenantId: input.tenantId,
        templateKey: input.templateKey,
        channel: CHANNEL_ENUM[input.channel],
        status: input.status,
        to: input.to,
        toName: input.toName,
        subject: input.subject,
        body: input.body,
        providerId: input.providerId,
        sentAt: input.sentAt,
        lastError: input.lastError,
        skipReason: input.skipReason,
        attachments: input.attachments?.length
          ? (input.attachments as unknown as object)
          : undefined,
        createdBy: input.createdBy,
      },
    });
  }
}
