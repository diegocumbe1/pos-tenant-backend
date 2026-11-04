import { forwardRef, Module } from '@nestjs/common';
import { AlexaModule } from '../integrations/alexa/alexa.module';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { PlanPricingService } from './pricing/plan-pricing.service';
import { PlanFeaturesService } from './plans/plan-features.service';
import { PublicPlanFeaturesController } from './plans/public-plan-features.controller';
import { PublicPricingController } from './pricing/public-pricing.controller';

@Module({
  // forwardRef: AlexaModule depende del asistente, que depende de éste.
  imports: [forwardRef(() => AlexaModule)],
  controllers: [PlatformController, PublicPricingController, PublicPlanFeaturesController],
  providers: [PlatformService, PlatformAdminGuard, PlanPricingService, PlanFeaturesService],
  exports: [PlatformService, PlanPricingService, PlanFeaturesService],
})
export class PlatformModule {}
