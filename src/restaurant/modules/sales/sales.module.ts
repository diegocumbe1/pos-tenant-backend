import { Module } from '@nestjs/common';
import { OrderEventsModule } from '../order-events/order-events.module';
import {
  OrderClaimsController,
  SalesController,
} from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [OrderEventsModule],
  controllers: [SalesController, OrderClaimsController],
  providers: [SalesService],
})
export class SalesModule {}
