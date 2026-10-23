import { Module } from '@nestjs/common';
import { BarberSharedModule } from '../../shared/barber-shared.module';
import { BarberRecurringController } from './barber-recurring.controller';
import { BarberRecurringService } from './barber-recurring.service';

@Module({
  imports: [BarberSharedModule],
  controllers: [BarberRecurringController],
  providers: [BarberRecurringService],
})
export class BarberRecurringModule {}
