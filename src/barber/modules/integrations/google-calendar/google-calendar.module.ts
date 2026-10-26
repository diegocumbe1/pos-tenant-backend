import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BarberSharedModule } from '../../../shared/barber-shared.module';
import { BarberClassesModule } from '../../classes/barber-classes.module';
import { GoogleCalendarPublicController } from './google-calendar-public.controller';
import { GoogleCalendarSyncInterceptor } from './google-calendar-sync.interceptor';
import { GoogleCalendarController } from './google-calendar.controller';
import { GoogleCalendarService } from './google-calendar.service';

@Module({
  imports: [BarberSharedModule, BarberClassesModule],
  controllers: [GoogleCalendarController, GoogleCalendarPublicController],
  providers: [
    GoogleCalendarService,
    { provide: APP_INTERCEPTOR, useClass: GoogleCalendarSyncInterceptor },
  ],
  exports: [GoogleCalendarService],
})
export class GoogleCalendarModule {}
