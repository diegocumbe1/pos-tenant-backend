import { Module } from '@nestjs/common';
import { BarberSharedModule } from '../../shared/barber-shared.module';
import { BarberStaffController } from './barber-staff.controller';
import { BarberStaffService } from './barber-staff.service';

@Module({
  imports: [BarberSharedModule],
  controllers: [BarberStaffController],
  providers: [BarberStaffService],
  exports: [BarberStaffService],
})
export class BarberStaffModule {}
