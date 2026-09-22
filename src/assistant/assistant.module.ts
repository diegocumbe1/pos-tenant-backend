import { AssistantTelemetryModule } from './telemetry/telemetry.module';
import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';
import { RetailCatalogModule } from '../retail/modules/catalog/retail-catalog.module';
import { RetailInventoryModule } from '../retail/modules/inventory/retail-inventory.module';
import { RetailPurchasesModule } from '../retail/modules/purchases/retail-purchases.module';
import { RetailSalesModule } from '../retail/modules/sales/retail-sales.module';
import { PlatformMessagingModule } from '../platform-messaging/platform-messaging.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { AssistantScopeService } from './assistant-scope.service';
import { AssistantService } from './assistant.service';
import { LynkoAgentService } from './agent/lynko-agent.service';
import { WhatsAppInboundService } from './channels/whatsapp-inbound.service';
import { ConversationService } from './conversation/conversation.service';
import { IdentityResolverService } from './identity/identity-resolver.service';
import { IntentResolverService } from './intents/intent-resolver.service';

@Module({
  imports: [
    AssistantTelemetryModule,
    forwardRef(() => PlatformModule),
    RetailSalesModule,
    RetailInventoryModule,
    RetailCatalogModule,
    RetailPurchasesModule,
    AuthModule,
    // Solo para el motor de sesión: el agente escucha sus eventos y responde
    // por el mismo cliente. La dependencia va en este sentido a propósito —
    // WhatsApp no sabe que el agente existe.
    WhatsAppModule,
    // Para el interruptor del agente, que vive con el resto de la mensajería de
    // plataforma y se maneja desde el backoffice.
    PlatformMessagingModule,
  ],
  providers: [
    AssistantService,
    AssistantScopeService,
    IdentityResolverService,
    ConversationService,
    IntentResolverService,
    LynkoAgentService,
    WhatsAppInboundService,
  ],
  exports: [
    AssistantService,
    AssistantScopeService,
    LynkoAgentService,
    AssistantTelemetryModule,
  ],
})
export class AssistantModule {}
