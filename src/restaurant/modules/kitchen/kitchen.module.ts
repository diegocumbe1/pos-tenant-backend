import { Module } from '@nestjs/common';
import { KitchenController } from './kitchen.controller';
import { KitchenService } from './kitchen.service';
import { OrderEventsModule } from '../order-events/order-events.module';
import { NotificationsModule } from '../../../notifications/notifications.module';

@Module({
  imports: [OrderEventsModule, NotificationsModule],
  controllers: [KitchenController],
  providers: [KitchenService],
})
export class KitchenModule {}
