import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module';
import { PlatformGatewayController } from './platform-gateway.controller';
import { WompiWebhookController } from './wompi-webhook.controller';
import { ChargesService } from './services/charges.service';
import { FeeRatesService } from './services/fee-rates.service';
import { GatewaySettingsService } from './services/gateway-settings.service';
import { WompiClient } from './services/wompi.client';

@Module({
  // PlatformModule trae PlatformService: la conciliación reutiliza su
  // `createPayment` en vez de duplicar el registro del pago y la extensión del
  // periodo, que ya llevan su propia auditoría.
  imports: [PlatformModule],
  controllers: [PlatformGatewayController, WompiWebhookController],
  providers: [
    GatewaySettingsService,
    WompiClient,
    ChargesService,
    FeeRatesService,
  ],
  exports: [
    GatewaySettingsService,
    WompiClient,
    ChargesService,
    FeeRatesService,
  ],
})
export class PlatformGatewayModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformGatewayModule.name);

  constructor(private readonly rates: FeeRatesService) {}

  /** Siembra las tarifas publicadas si faltan. No pisa lo que el admin editó. */
  async onApplicationBootstrap() {
    try {
      const created = await this.rates.seedMissing();
      if (created > 0) {
        this.logger.log(`Tarifas de pasarela sembradas: ${created}`);
      }
    } catch (err) {
      // Que no tumbe el arranque: sin filas se usan los valores de fábrica.
      this.logger.warn(
        `No se pudieron sembrar las tarifas: ${(err as Error).message}`,
      );
    }
  }
}
