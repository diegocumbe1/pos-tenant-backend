import { Module } from '@nestjs/common';
import { RetailSharedModule } from '../../shared/retail-shared.module';
import { RetailSalesController } from './retail-sales.controller';
import { RetailSaleReturnsService } from './retail-sale-returns.service';
import { RetailSalesService } from './retail-sales.service';

@Module({
  imports: [RetailSharedModule],
  controllers: [RetailSalesController],
  providers: [RetailSalesService, RetailSaleReturnsService],
  exports: [RetailSalesService, RetailSaleReturnsService],
})
export class RetailSalesModule {}
