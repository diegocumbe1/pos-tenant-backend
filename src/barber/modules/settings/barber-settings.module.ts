import { Module } from '@nestjs/common';
import { BarberSharedModule } from '../../shared/barber-shared.module';
import { BarberSettingsController } from './barber-settings.controller';
import { BarberSettingsService } from './barber-settings.service';

@Module({
  imports: [BarberSharedModule],
  controllers: [BarberSettingsController],
  providers: [BarberSettingsService],
  exports: [BarberSettingsService],
})
export class BarberSettingsModule {}
