import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';
import { RetailSalesModule } from '../retail/modules/sales/retail-sales.module';
import { AssistantScopeService } from './assistant-scope.service';
import { AssistantService } from './assistant.service';

@Module({
  imports: [PlatformModule, RetailSalesModule, AuthModule],
  providers: [AssistantService, AssistantScopeService],
  exports: [AssistantService, AssistantScopeService],
})
export class AssistantModule {}
