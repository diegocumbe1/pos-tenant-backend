import { Module } from '@nestjs/common';
import { NotificationsModule } from '../../../notifications/notifications.module';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AppointmentRemindersController } from './appointment-reminders.controller';
import { AppointmentRemindersService } from './appointment-reminders.service';
import { PaymentAlertsService } from './payment-alerts.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [AppointmentRemindersController],
  providers: [AppointmentRemindersService, PaymentAlertsService],
})
export class AppointmentRemindersModule {}
