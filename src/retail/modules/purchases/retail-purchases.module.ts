import { Module } from '@nestjs/common';
import { RetailSharedModule } from '../../shared/retail-shared.module';
import { RetailPurchasesController } from './retail-purchases.controller';
import { RetailPurchasesService } from './retail-purchases.service';

@Module({
  imports: [RetailSharedModule],
  controllers: [RetailPurchasesController],
  providers: [RetailPurchasesService],
  exports: [RetailPurchasesService],
})
export class RetailPurchasesModule {}
