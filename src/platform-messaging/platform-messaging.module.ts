import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { EmailPlatformChannel } from './channels/email.channel';
import { WhatsAppPlatformChannel } from './channels/whatsapp.channel';
import {
  EMAIL_CHANNEL,
  WHATSAPP_CHANNEL,
} from './channels/channel.interface';
import { PlatformMessagingController } from './platform-messaging.controller';
import { MessageSenderService } from './services/message-sender.service';
import { MessagingSettingsService } from './services/messaging-settings.service';
import { PaymentMethodsService } from './services/payment-methods.service';
import { RecipientResolverService } from './services/recipient-resolver.service';
import { SubscriptionContextService } from './services/subscription-context.service';
import { TemplateRendererService } from './services/template-renderer.service';
import { TemplatesService } from './services/templates.service';
import { PrismaService } from '../prisma/prisma.service';
import { SEED_PAYMENT_METHOD } from './seed-templates';

@Module({
  imports: [WhatsAppModule],
  controllers: [PlatformMessagingController],
  providers: [
    TemplatesService,
    TemplateRendererService,
    SubscriptionContextService,
    RecipientResolverService,
    PaymentMethodsService,
    MessagingSettingsService,
    MessageSenderService,
    WhatsAppPlatformChannel,
    EmailPlatformChannel,
    { provide: WHATSAPP_CHANNEL, useExisting: WhatsAppPlatformChannel },
    { provide: EMAIL_CHANNEL, useExisting: EmailPlatformChannel },
  ],
  exports: [MessageSenderService],
})
export class PlatformMessagingModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformMessagingModule.name);

  constructor(
    private readonly templates: TemplatesService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Siembra plantillas y el medio de pago inicial si faltan. Idempotente: no
   * pisa nada que el super-admin haya editado desde la consola.
   */
  async onApplicationBootstrap() {
    try {
      const { created } = await this.templates.seedMissing();
      if (created > 0) {
        this.logger.log(`Plantillas de mensajería sembradas: ${created}`);
      }

      const methods = await this.prisma.platformPaymentMethod.count();
      if (methods === 0) {
        await this.prisma.platformPaymentMethod.create({
          data: SEED_PAYMENT_METHOD,
        });
        this.logger.log(
          `Medio de pago inicial sembrado: ${SEED_PAYMENT_METHOD.label}`,
        );
      }
    } catch (err) {
      // Que no tumbe el arranque: sin plantillas la consola muestra el vacío y
      // se puede sembrar de nuevo reiniciando.
      this.logger.warn(
        `No se pudo sembrar la mensajería de plataforma: ${(err as Error).message}`,
      );
    }
  }
}
