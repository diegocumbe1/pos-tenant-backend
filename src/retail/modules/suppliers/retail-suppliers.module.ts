import { Module } from '@nestjs/common';
import { RetailSharedModule } from '../../shared/retail-shared.module';
import { RetailSuppliersController } from './retail-suppliers.controller';
import { RetailSuppliersService } from './retail-suppliers.service';

@Module({
  imports: [RetailSharedModule],
  controllers: [RetailSuppliersController],
  providers: [RetailSuppliersService],
  exports: [RetailSuppliersService],
})
export class RetailSuppliersModule {}
