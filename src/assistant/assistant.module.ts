import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';
import { RetailCatalogModule } from '../retail/modules/catalog/retail-catalog.module';
import { RetailInventoryModule } from '../retail/modules/inventory/retail-inventory.module';
import { RetailPurchasesModule } from '../retail/modules/purchases/retail-purchases.module';
import { RetailSalesModule } from '../retail/modules/sales/retail-sales.module';
import { AssistantScopeService } from './assistant-scope.service';
import { AssistantService } from './assistant.service';

@Module({
  imports: [
    forwardRef(() => PlatformModule),
    RetailSalesModule,
    RetailInventoryModule,
    RetailCatalogModule,
    RetailPurchasesModule,
    AuthModule,
  ],
  providers: [AssistantService, AssistantScopeService],
  exports: [AssistantService, AssistantScopeService],
})
export class AssistantModule {}
