import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PlatformModule } from '../platform/platform.module';
import { CatalogAdminController } from './catalog-admin.controller';
import { CatalogPublicController } from './catalog-public.controller';
import { CatalogPricingService } from './catalog-pricing.service';
import { CatalogService } from './catalog.service';

/**
 * Catálogos gestionados: el servicio de temporada para vendedores sin cuenta.
 *
 * `ImageUploadService` y `SupabaseService` no se importan porque sus módulos son
 * `@Global()`.
 *
 * Ver docs/CATALOGOS_GESTIONADOS_PLAN.md.
 */
@Module({
  // `PlatformModule` por `PlanPricingService`: la tasa USD→COP es una sola para
  // toda la plataforma, y tener una copia acá haría que las tarifas de catálogo
  // se conviertan con un dólar distinto al de los planes.
  imports: [PrismaModule, PlatformModule],
  controllers: [CatalogAdminController, CatalogPublicController],
  providers: [CatalogService, CatalogPricingService],
  exports: [CatalogService],
})
export class CatalogModule {}
