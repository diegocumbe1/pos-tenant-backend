import { Module } from '@nestjs/common';
import { BarberSharedModule } from '../../shared/barber-shared.module';
import { BarberAppointmentsModule } from '../appointments/barber-appointments.module';
import { BarberServiceCategoriesController } from './barber-service-categories.controller';
import { BarberServiceCategoriesService } from './barber-service-categories.service';
import { BarberServiceAssetsController } from './barber-service-assets.controller';
import { BarberServiceAssetsService } from './barber-service-assets.service';
import { BarberServicesController } from './barber-services.controller';
import { BarberServicesService } from './barber-services.service';

@Module({
  imports: [BarberSharedModule, BarberAppointmentsModule],
  controllers: [
    BarberServicesController,
    BarberServiceAssetsController,
    BarberServiceCategoriesController,
  ],
  providers: [
    BarberServicesService,
    BarberServiceAssetsService,
    BarberServiceCategoriesService,
  ],
  exports: [BarberServicesService, BarberServiceAssetsService],
})
export class BarberServicesModule {}
