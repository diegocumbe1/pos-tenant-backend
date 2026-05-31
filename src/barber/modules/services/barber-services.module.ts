import { Module } from '@nestjs/common';
import { BarberSharedModule } from '../../shared/barber-shared.module';
import { BarberServiceAssetsController } from './barber-service-assets.controller';
import { BarberServiceAssetsService } from './barber-service-assets.service';
import { BarberServicesController } from './barber-services.controller';
import { BarberServicesService } from './barber-services.service';

@Module({
  imports: [BarberSharedModule],
  controllers: [BarberServicesController, BarberServiceAssetsController],
  providers: [BarberServicesService, BarberServiceAssetsService],
  exports: [BarberServicesService, BarberServiceAssetsService],
})
export class BarberServicesModule {}
