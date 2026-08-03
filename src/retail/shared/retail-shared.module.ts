import { Module } from '@nestjs/common';
import { RetailTenantHelper } from './retail-tenant.helper';

@Module({
  providers: [RetailTenantHelper],
  exports: [RetailTenantHelper],
})
export class RetailSharedModule {}
