import { Module } from '@nestjs/common';
import { ProductsModule } from './modules/products/products.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { AreasModule } from './modules/areas/areas.module';
import { TablesModule } from './modules/tables/tables.module';
import { OrdersModule } from './modules/orders/orders.module';

@Module({
  imports: [ProductsModule, CategoriesModule, AreasModule, TablesModule, OrdersModule],
})
export class RestaurantModule {}
