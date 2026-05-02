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
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
