import { Module } from '@nestjs/common';
import { RetailSharedModule } from '../../shared/retail-shared.module';
import { RetailExpiryController } from './retail-expiry.controller';
import { RetailExpiryService } from './retail-expiry.service';
import { RetailInventoryController } from './retail-inventory.controller';
import { RetailInventoryService } from './retail-inventory.service';

@Module({
  imports: [RetailSharedModule],
  controllers: [RetailInventoryController, RetailExpiryController],
  providers: [RetailInventoryService, RetailExpiryService],
  exports: [RetailInventoryService],
})
export class RetailInventoryModule {}
