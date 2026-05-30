import { Module } from '@nestjs/common';
import { BarberTenantHelper } from './barber-tenant.helper';

@Module({
  providers: [BarberTenantHelper],
  exports: [BarberTenantHelper],
})
export class BarberSharedModule {}
