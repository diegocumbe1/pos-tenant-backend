import { Module } from '@nestjs/common';
import { ProductsModule } from './modules/products/products.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { AreasModule } from './modules/areas/areas.module';
import { TablesModule } from './modules/tables/tables.module';
import { OrdersModule } from './modules/orders/orders.module';
import { KitchenModule } from './modules/kitchen/kitchen.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { MenuPublicModule } from './modules/menu-public/menu-public.module';

@Module({
  imports: [
    ProductsModule,
    CategoriesModule,
    AreasModule,
    TablesModule,
    OrdersModule,
    KitchenModule,
    ReservationsModule,
    InventoryModule,
    MenuPublicModule,
  ],
})
export class RestaurantModule {}
