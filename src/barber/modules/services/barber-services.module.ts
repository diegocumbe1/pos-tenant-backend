import { Module } from '@nestjs/common';
import { BarberSharedModule } from '../../shared/barber-shared.module';
import { BarberServicesController } from './barber-services.controller';
import { BarberServicesService } from './barber-services.service';

@Module({
  imports: [BarberSharedModule],
  controllers: [BarberServicesController],
  providers: [BarberServicesService],
  exports: [BarberServicesService],
})
export class BarberServicesModule {}
