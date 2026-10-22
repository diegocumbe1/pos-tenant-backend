import { Module } from '@nestjs/common';
import { RetailSharedModule } from '../../shared/retail-shared.module';
import { RetailSalesModule } from '../sales/retail-sales.module';
import { RetailLocationsController } from './retail-locations.controller';
import { RetailLocationsService } from './retail-locations.service';
import { RetailStockCountsController } from './retail-stock-counts.controller';
import { RetailStockCountsService } from './retail-stock-counts.service';

@Module({
  // Ventas: la revista de un aliado se liquida como una venta.
  imports: [RetailSharedModule, RetailSalesModule],
  controllers: [RetailLocationsController, RetailStockCountsController],
  providers: [RetailLocationsService, RetailStockCountsService],
  exports: [RetailLocationsService],
})
export class RetailLocationsModule {}
