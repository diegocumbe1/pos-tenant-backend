import { Module } from '@nestjs/common';
import { RetailSharedModule } from '../../shared/retail-shared.module';
import { RetailInventoryController } from './retail-inventory.controller';
import { RetailInventoryService } from './retail-inventory.service';

@Module({
  imports: [RetailSharedModule],
  controllers: [RetailInventoryController],
  providers: [RetailInventoryService],
  exports: [RetailInventoryService],
})
export class RetailInventoryModule {}
