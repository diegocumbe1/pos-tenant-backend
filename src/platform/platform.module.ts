import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { PlanPricingService } from './pricing/plan-pricing.service';
import { PublicPricingController } from './pricing/public-pricing.controller';

@Module({
  controllers: [PlatformController, PublicPricingController],
  providers: [PlatformService, PlatformAdminGuard, PlanPricingService],
  exports: [PlatformService, PlanPricingService],
})
export class PlatformModule {}
