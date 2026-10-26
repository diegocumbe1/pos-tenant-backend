import { Module } from '@nestjs/common';
import { BarberAppointmentsModule } from './modules/appointments/barber-appointments.module';
import { BarberChargesModule } from './modules/charges/barber-charges.module';
import { BarberClassesModule } from './modules/classes/barber-classes.module';
import { BarberRecurringModule } from './modules/recurring/barber-recurring.module';
import { InMoveSyncModule } from './modules/integrations/inmove/inmove-sync.module';
import { GoogleCalendarModule } from './modules/integrations/google-calendar/google-calendar.module';
import { BarberCustomersModule } from './modules/customers/barber-customers.module';
import { BarberPublicModule } from './modules/public/barber-public.module';
import { PublicSiteModule } from '../public-site/admin/public-site.module';
import { BarberServicesModule } from './modules/services/barber-services.module';
import { BarberSettingsModule } from './modules/settings/barber-settings.module';
import { BarberStaffModule } from './modules/staff/barber-staff.module';

@Module({
  imports: [
    BarberSettingsModule,
    BarberServicesModule,
    BarberStaffModule,
    BarberCustomersModule,
    BarberAppointmentsModule,
    BarberChargesModule,
    BarberClassesModule,
    BarberRecurringModule,
    InMoveSyncModule,
    GoogleCalendarModule,
    PublicSiteModule,
    BarberPublicModule,
  ],
})
export class BarberModule {}
