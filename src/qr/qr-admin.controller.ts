import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/types/tenant-context.interface';
import { PlatformActor } from '../platform/decorators/platform-actor.decorator';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard';
import { CreateQrCodeDto, RevokeQrCodeDto, UpdateQrCodeDto } from './dto/qr.dto';
import { QrService } from './qr.service';

/**
 * QR permanentes desde el backoffice.
 *
 * Guards: `JwtAuthGuard` → `PlatformAdminGuard`, el mismo par de
 * `platform.controller.ts` y `catalog-admin.controller.ts`. Sin TenantGuard y
 * sin `X-Tenant-Id`: el superadmin entra a la ficha de CUALQUIER tenant.
 *
 * Un usuario del propio negocio NO administra su QR: el código es material
 * impreso y rotarlo por error deja tarjetas muertas en la calle.
 */
@ApiTags('Platform')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform')
export class QrAdminController {
  constructor(private readonly qr: QrService) {}

  // ─── QR de la propia Lynko (Configuración) ──────────────────────────────────
  // Declarado ANTES de `tenants/:tenantId/qr` por claridad; no compite, pero el
  // orden de declaración es el que Nest respeta y así se lee junto.

  @Get('qr/landing')
  @ApiOperation({ summary: 'QR permanente de la landing de Lynko' })
  getPlatformQr() {
    return this.qr.getPlatform();
  }

  @Post('qr/landing')
  @ApiOperation({ summary: 'Generar el QR de Lynko (idempotente)' })
  createPlatformQr(
    @Body() dto: CreateQrCodeDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.qr.createPlatform(dto, actor.id);
  }

  @Patch('qr/landing')
  @ApiOperation({ summary: 'Cambiar destino/estado/textos del QR de Lynko' })
  updatePlatformQr(
    @Body() dto: UpdateQrCodeDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.qr.updatePlatform(dto, actor.id);
  }

  @Post('qr/landing/revoke')
  @ApiOperation({
    summary: 'Revocar y generar código nuevo',
    description: 'Los QR impresos con el código anterior dejan de funcionar.',
  })
  revokePlatformQr(
    @Body() dto: RevokeQrCodeDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.qr.revokePlatform(dto.reason, actor.id);
  }

  // ─── QR de un tenant (ficha → Tarjeta) ──────────────────────────────────────

  @Get('tenants/:tenantId/qr')
  @ApiOperation({
    summary: 'QR permanente del tenant (null si todavía no tiene)',
    description:
      'Incluye la marca resuelta del negocio y el destino sugerido para el alta.',
  })
  getTenantQr(@Param('tenantId') tenantId: string) {
    return this.qr.getForTenant(tenantId);
  }

  @Post('tenants/:tenantId/qr')
  @ApiOperation({
    summary: 'Generar el QR permanente del tenant',
    description:
      'Idempotente: si ya existe devuelve el mismo código, nunca uno nuevo.',
  })
  createTenantQr(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateQrCodeDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.qr.createForTenant(tenantId, dto, actor.id);
  }

  @Patch('tenants/:tenantId/qr')
  @ApiOperation({ summary: 'Cambiar destino/estado/textos sin tocar el código' })
  updateTenantQr(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateQrCodeDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.qr.updateForTenant(tenantId, dto, actor.id);
  }

  @Post('tenants/:tenantId/qr/revoke')
  @ApiOperation({
    summary: 'Revocar y generar código nuevo',
    description: 'Los QR impresos con el código anterior dejan de funcionar.',
  })
  revokeTenantQr(
    @Param('tenantId') tenantId: string,
    @Body() dto: RevokeQrCodeDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.qr.revokeForTenant(tenantId, dto.reason, actor.id);
  }
}
