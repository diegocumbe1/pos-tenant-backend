import { Module } from '@nestjs/common';
import { RetailSharedModule } from '../../shared/retail-shared.module';
import { NotificationsModule } from '../../../notifications/notifications.module';
import { RetailPaymentCommitmentsController } from './retail-payment-commitments.controller';
import { RetailPaymentCommitmentsService } from './retail-payment-commitments.service';
import { RetailSalesController } from './retail-sales.controller';
import { RetailSaleReturnsService } from './retail-sale-returns.service';
import { RetailSalesService } from './retail-sales.service';

@Module({
  imports: [RetailSharedModule, NotificationsModule],
  controllers: [RetailSalesController, RetailPaymentCommitmentsController],
  providers: [
    RetailSalesService,
    RetailSaleReturnsService,
    RetailPaymentCommitmentsService,
  ],
  exports: [RetailSalesService, RetailSaleReturnsService],
})
export class RetailSalesModule {}
