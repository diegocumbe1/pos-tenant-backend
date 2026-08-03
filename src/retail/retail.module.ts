import { Module } from '@nestjs/common';
import { RetailCatalogModule } from './modules/catalog/retail-catalog.module';
import { RetailCustomersModule } from './modules/customers/retail-customers.module';
import { RetailInventoryModule } from './modules/inventory/retail-inventory.module';
import { RetailSalesModule } from './modules/sales/retail-sales.module';

/**
 * [VERTICAL_RETAIL] Vertical de tienda: catálogo, inventario, POS de mostrador y
 * clientes. No importa nada de restaurant/ ni de barber/ — lo transversal
 * (finanzas, nómina, usuarios, assets, sitio público) vive en sus propios módulos.
 */
@Module({
  imports: [
    RetailCatalogModule,
    RetailInventoryModule,
    RetailSalesModule,
    RetailCustomersModule,
  ],
})
export class RetailModule {}
