import { Module } from '@nestjs/common';
import { BarberSharedModule } from '../../shared/barber-shared.module';
import { BarberChargesController } from './barber-charges.controller';
import { BarberChargesService } from './barber-charges.service';
import { BarberCustomerAccountService } from './barber-customer-account.service';

@Module({
  imports: [BarberSharedModule],
  controllers: [BarberChargesController],
  providers: [BarberChargesService, BarberCustomerAccountService],
  exports: [BarberChargesService],
})
export class BarberChargesModule {}
