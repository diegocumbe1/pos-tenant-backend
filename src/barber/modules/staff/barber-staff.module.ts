import { Module } from '@nestjs/common';
import { TenantAdminModule } from '../../../tenant-admin/tenant-admin.module';
import { BarberSharedModule } from '../../shared/barber-shared.module';
import { BarberStaffController } from './barber-staff.controller';
import { BarberStaffService } from './barber-staff.service';

@Module({
  imports: [BarberSharedModule, TenantAdminModule],
  controllers: [BarberStaffController],
  providers: [BarberStaffService],
  exports: [BarberStaffService],
})
export class BarberStaffModule {}
