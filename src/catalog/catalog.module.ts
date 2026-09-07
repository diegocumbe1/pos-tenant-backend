import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CatalogAdminController } from './catalog-admin.controller';
import { CatalogPublicController } from './catalog-public.controller';
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
  imports: [PrismaModule],
  controllers: [CatalogAdminController, CatalogPublicController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
