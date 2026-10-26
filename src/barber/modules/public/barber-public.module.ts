import { Module } from '@nestjs/common';
import { PublicSiteModule } from '../../../public-site/admin/public-site.module';
import { NotificationsModule } from '../../../notifications/notifications.module';
import { GoogleCalendarModule } from '../integrations/google-calendar/google-calendar.module';
import { BarberPublicController } from './barber-public.controller';
import { BarberPublicService } from './barber-public.service';

@Module({
  imports: [PublicSiteModule, NotificationsModule, GoogleCalendarModule],
  controllers: [BarberPublicController],
  providers: [BarberPublicService],
  exports: [BarberPublicService],
})
export class BarberPublicModule {}
