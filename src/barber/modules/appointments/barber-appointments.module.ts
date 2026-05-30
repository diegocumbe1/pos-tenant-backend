import { Module } from '@nestjs/common';
import { BarberSharedModule } from '../../shared/barber-shared.module';
import { BarberAppointmentsController } from './barber-appointments.controller';
import { BarberAppointmentsService } from './barber-appointments.service';

@Module({
  imports: [BarberSharedModule],
  controllers: [BarberAppointmentsController],
  providers: [BarberAppointmentsService],
  exports: [BarberAppointmentsService],
})
export class BarberAppointmentsModule {}
