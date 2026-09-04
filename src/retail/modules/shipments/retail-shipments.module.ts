import { Module } from '@nestjs/common';
import { RetailSharedModule } from '../../shared/retail-shared.module';
import { RetailSalesModule } from '../sales/retail-sales.module';
import { RetailShipmentsController } from './retail-shipments.controller';
import { RetailShipmentsService } from './retail-shipments.service';

/**
 * Importa ventas porque despachar un envío ES entregar sus ventas: se reusa
 * `RetailSalesService.deliverInTransaction` para que el kardex y el cierre de la
 * venta sigan siendo un solo camino, en vez de tener dos copias de la misma
 * lógica de inventario que se irían separando con el tiempo.
 */
@Module({
  imports: [RetailSharedModule, RetailSalesModule],
  controllers: [RetailShipmentsController],
  providers: [RetailShipmentsService],
})
export class RetailShipmentsModule {}
