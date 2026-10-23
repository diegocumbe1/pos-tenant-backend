import { Module } from '@nestjs/common';
import { BarberSharedModule } from '../../shared/barber-shared.module';
import { BarberAppointmentsModule } from '../appointments/barber-appointments.module';
import { BarberChargesModule } from '../charges/barber-charges.module';
import { BarberClassesController } from './barber-classes.controller';
import { BarberClassesService } from './barber-classes.service';

@Module({
  imports: [BarberSharedModule, BarberAppointmentsModule, BarberChargesModule],
  controllers: [BarberClassesController],
  providers: [BarberClassesService],
})
export class BarberClassesModule {}
