import { Module } from '@nestjs/common';
import { RetailSharedModule } from '../../shared/retail-shared.module';
import { RetailFinancingController } from './retail-financing.controller';
import { RetailFinancingService } from './retail-financing.service';

@Module({
  imports: [RetailSharedModule],
  controllers: [RetailFinancingController],
  providers: [RetailFinancingService],
  exports: [RetailFinancingService],
})
export class RetailFinancingModule {}
