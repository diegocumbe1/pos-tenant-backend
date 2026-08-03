import { Module } from '@nestjs/common';
import { RetailSharedModule } from '../../shared/retail-shared.module';
import { RetailSalesController } from './retail-sales.controller';
import { RetailSalesService } from './retail-sales.service';

@Module({
  imports: [RetailSharedModule],
  controllers: [RetailSalesController],
  providers: [RetailSalesService],
  exports: [RetailSalesService],
})
export class RetailSalesModule {}
