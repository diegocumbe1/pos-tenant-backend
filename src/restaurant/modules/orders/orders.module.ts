import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderEventsModule } from '../order-events/order-events.module';
import { PrintingModule } from '../printing/printing.module';
import { ReceiptsModule } from '../receipts/receipts.module';
import { CashSessionsModule } from '../cash-sessions/cash-sessions.module';
import { NotificationsModule } from '../../../notifications/notifications.module';

@Module({
  imports: [
    OrderEventsModule,
    PrintingModule,
    ReceiptsModule,
    CashSessionsModule,
    NotificationsModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
