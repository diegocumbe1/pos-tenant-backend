import { Module } from '@nestjs/common';
import { BarberAppointmentsModule } from './modules/appointments/barber-appointments.module';
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
    PublicSiteModule,
    BarberPublicModule,
  ],
})
export class BarberModule {}
