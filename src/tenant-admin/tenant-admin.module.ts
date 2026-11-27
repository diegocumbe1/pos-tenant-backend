import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { TenantAddVerticalService } from './tenant-add-vertical.service';
import { TenantAdminController } from './tenant-admin.controller';
import { TenantAdminService } from './tenant-admin.service';
import { TenantPlanService } from './tenant-plan.service';
import { BillingGroupsService } from '../platform/billing-groups/billing-groups.service';
import { PlanPricingService } from '../platform/pricing/plan-pricing.service';
import { WebPushProvider } from '../notifications/web-push.provider';

@Module({
  imports: [AdminModule],
  controllers: [TenantAdminController],
  // PlanPricing/BillingGroups solo dependen de Prisma: se registran aquí en vez
  // de importar PlatformModule (que arrastra Alexa y el asistente).
  providers: [
    TenantAdminService,
    TenantPlanService,
    TenantAddVerticalService,
    PlanPricingService,
    BillingGroupsService,
    // Stateless (claves VAPID): para avisarle al super-admin de una vertical nueva.
    WebPushProvider,
  ],
  exports: [TenantAdminService],
})
export class TenantAdminModule {}
