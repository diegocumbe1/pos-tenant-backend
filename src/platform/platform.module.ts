import { forwardRef, Module } from '@nestjs/common';
import { AlexaModule } from '../integrations/alexa/alexa.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlatformAlertsController } from './alerts/platform-alerts.controller';
import { PlatformAlertsService } from './alerts/platform-alerts.service';
import { BillingGroupsController } from './billing-groups/billing-groups.controller';
import { BillingGroupsService } from './billing-groups/billing-groups.service';
import { TenantMembershipsController } from './memberships/tenant-memberships.controller';
import { TenantMembershipsService } from './memberships/tenant-memberships.service';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { PlanPricingService } from './pricing/plan-pricing.service';
import { PlanFeaturesService } from './plans/plan-features.service';
import { PublicPlanFeaturesController } from './plans/public-plan-features.controller';
import { PublicPricingController } from './pricing/public-pricing.controller';

@Module({
  // forwardRef: AlexaModule depende del asistente, que depende de éste.
  imports: [forwardRef(() => AlexaModule), NotificationsModule],
  controllers: [
    PlatformController,
    PlatformAlertsController,
    TenantMembershipsController,
    BillingGroupsController,
    PublicPricingController,
    PublicPlanFeaturesController,
  ],
  providers: [
    PlatformService,
    PlatformAdminGuard,
    PlanPricingService,
    PlanFeaturesService,
    PlatformAlertsService,
    TenantMembershipsService,
    BillingGroupsService,
  ],
  exports: [PlatformService, PlanPricingService, PlanFeaturesService, BillingGroupsService],
})
export class PlatformModule {}
