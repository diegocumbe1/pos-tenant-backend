import { Module } from '@nestjs/common';
import { TenantAdminController } from './tenant-admin.controller';
import { TenantAdminService } from './tenant-admin.service';
import { TenantPlanService } from './tenant-plan.service';
import { BillingGroupsService } from '../platform/billing-groups/billing-groups.service';
import { PlanPricingService } from '../platform/pricing/plan-pricing.service';

@Module({
  controllers: [TenantAdminController],
  // PlanPricing/BillingGroups solo dependen de Prisma: se registran aquí en vez
  // de importar PlatformModule (que arrastra Alexa y el asistente).
  providers: [
    TenantAdminService,
    TenantPlanService,
    PlanPricingService,
    BillingGroupsService,
  ],
  exports: [TenantAdminService],
})
export class TenantAdminModule {}
