import { Module } from '@nestjs/common';
import { RetailSharedModule } from '../../shared/retail-shared.module';
import { RetailLocationsController } from './retail-locations.controller';
import { RetailLocationsService } from './retail-locations.service';

@Module({
  imports: [RetailSharedModule],
  controllers: [RetailLocationsController],
  providers: [RetailLocationsService],
  exports: [RetailLocationsService],
})
export class RetailLocationsModule {}
