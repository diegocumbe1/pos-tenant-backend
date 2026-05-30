import { Module } from '@nestjs/common';
import { BarberSharedModule } from '../../shared/barber-shared.module';
import { BarberCustomersController } from './barber-customers.controller';
import { BarberCustomersService } from './barber-customers.service';

@Module({
  imports: [BarberSharedModule],
  controllers: [BarberCustomersController],
  providers: [BarberCustomersService],
  exports: [BarberCustomersService],
})
export class BarberCustomersModule {}
