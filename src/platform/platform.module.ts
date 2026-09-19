import { forwardRef, Module } from '@nestjs/common';
import { AlexaModule } from '../integrations/alexa/alexa.module';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { PlanPricingService } from './pricing/plan-pricing.service';
import { PublicPricingController } from './pricing/public-pricing.controller';

@Module({
  // forwardRef: AlexaModule depende del asistente, que depende de éste.
  imports: [forwardRef(() => AlexaModule)],
  controllers: [PlatformController, PublicPricingController],
  providers: [PlatformService, PlatformAdminGuard, PlanPricingService],
  exports: [PlatformService, PlanPricingService],
})
export class PlatformModule {}
