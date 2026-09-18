import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module';
import { PlatformGatewayController } from './platform-gateway.controller';
import { WompiWebhookController } from './wompi-webhook.controller';
import { ChargesService } from './services/charges.service';
import { GatewaySettingsService } from './services/gateway-settings.service';
import { WompiClient } from './services/wompi.client';

@Module({
  // PlatformModule trae PlatformService: la conciliación reutiliza su
  // `createPayment` en vez de duplicar el registro del pago y la extensión del
  // periodo, que ya llevan su propia auditoría.
  imports: [PlatformModule],
  controllers: [PlatformGatewayController, WompiWebhookController],
  providers: [GatewaySettingsService, WompiClient, ChargesService],
  exports: [GatewaySettingsService, WompiClient, ChargesService],
})
export class PlatformGatewayModule {}
