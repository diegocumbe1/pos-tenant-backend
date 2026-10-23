import { Module } from '@nestjs/common';
import { BarberSharedModule } from '../../shared/barber-shared.module';
import { BarberChargesController } from './barber-charges.controller';
import { BarberChargesService } from './barber-charges.service';

@Module({
  imports: [BarberSharedModule],
  controllers: [BarberChargesController],
  providers: [BarberChargesService],
  exports: [BarberChargesService],
})
export class BarberChargesModule {}
