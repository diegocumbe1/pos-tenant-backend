import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppSessionManager } from './whatsapp-session.manager';
import { MESSAGING_PROVIDER } from './providers/messaging-provider.interface';
import { WhatsAppWebJsProvider } from './providers/whatsapp-webjs.provider';

@Module({
  controllers: [WhatsAppController],
  providers: [
    WhatsAppService,
    WhatsAppSessionManager,
    { provide: MESSAGING_PROVIDER, useClass: WhatsAppWebJsProvider },
  ],
  // El session manager se exporta para que la mensajería de plataforma pueda
  // manejar su propia sesión (el número de Lynko) sin duplicar el motor.
  exports: [WhatsAppService, WhatsAppSessionManager],
})
export class WhatsAppModule {}
