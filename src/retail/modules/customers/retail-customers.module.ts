import { Module } from '@nestjs/common';
import { RetailSharedModule } from '../../shared/retail-shared.module';
import { RetailCustomersController } from './retail-customers.controller';
import { RetailCustomersService } from './retail-customers.service';

@Module({
  imports: [RetailSharedModule],
  controllers: [RetailCustomersController],
  providers: [RetailCustomersService],
  exports: [RetailCustomersService],
})
export class RetailCustomersModule {}
