import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { QrAdminController } from './qr-admin.controller';
import { QrBranchController } from './qr-branch.controller';
import { QrPublicController } from './qr-public.controller';
import { QrService } from './qr.service';

/**
 * QR permanentes: tarjeta de presentación de cada negocio y QR de la landing.
 *
 * La pareja admin/público es la misma de `CatalogModule`: un controller detrás
 * de `PlatformAdminGuard` para administrar, y otro sin guards para resolver lo
 * que alguien escanea.
 *
 * El tercero es del lado del negocio (`/tenant/branches/:id/payment-qr`): la
 * escarapela de cobro la genera el dueño, no la plataforma.
 */
@Module({
  imports: [PrismaModule],
  controllers: [QrAdminController, QrBranchController, QrPublicController],
  providers: [QrService],
  exports: [QrService],
})
export class QrModule {}
