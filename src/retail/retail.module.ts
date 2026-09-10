import { Module } from '@nestjs/common';
import { RetailCatalogModule } from './modules/catalog/retail-catalog.module';
import { RetailCustomersModule } from './modules/customers/retail-customers.module';
import { RetailInventoryModule } from './modules/inventory/retail-inventory.module';
import { RetailLocationsModule } from './modules/locations/retail-locations.module';
import { RetailPurchasesModule } from './modules/purchases/retail-purchases.module';
import { RetailSalesModule } from './modules/sales/retail-sales.module';
import { RetailShipmentsModule } from './modules/shipments/retail-shipments.module';
import { RetailSuppliersModule } from './modules/suppliers/retail-suppliers.module';

/**
 * [VERTICAL_RETAIL] Vertical de tienda: lista de pedidos al proveedor, catálogo,
 * inventario, POS de mostrador, envíos y clientes. No importa nada de restaurant/ ni de
 * barber/ — lo transversal (finanzas, nómina, usuarios, assets, sitio público)
 * vive en sus propios módulos.
 */
@Module({
  imports: [
    RetailPurchasesModule,
    RetailSuppliersModule,
    RetailCatalogModule,
    RetailInventoryModule,
    RetailLocationsModule,
    RetailSalesModule,
    RetailShipmentsModule,
    RetailCustomersModule,
  ],
})
export class RetailModule {}
