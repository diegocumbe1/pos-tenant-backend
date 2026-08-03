import { Module } from '@nestjs/common';
import { RetailSharedModule } from '../../shared/retail-shared.module';
import {
  RetailCategoriesController,
  RetailProductsController,
} from './retail-catalog.controller';
import { RetailCatalogService } from './retail-catalog.service';

@Module({
  imports: [RetailSharedModule],
  controllers: [RetailCategoriesController, RetailProductsController],
  providers: [RetailCatalogService],
  exports: [RetailCatalogService],
})
export class RetailCatalogModule {}
