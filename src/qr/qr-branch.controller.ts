import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { RequireAnyPermission } from '../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../auth/guards/password-set.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { RevokeQrCodeDto, UpdateQrCodeDto } from './dto/qr.dto';
import { QrService } from './qr.service';

/**
 * Escarapela de cobro de una sede, desde la app del propio negocio.
 *
 * A diferencia de la tarjeta de presentación (que administra el superadmin),
 * esta la maneja el dueño: es SU llave, SU cuenta y SU cartón en el mostrador,
 * y tener que pedirle a Lynko que se la genere cada vez que abre una sede no
 * tiene sentido.
 *
 * Mismos guards y mismos permisos que editar los datos de pago de la sede
 * (`PATCH /tenant/branches/:id`): quien puede cambiar la cuenta a la que le
 * entra la plata es quien puede imprimir el cartón que la anuncia.
 */
@ApiTags('TenantAdmin')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('tenant/branches')
export class QrBranchController {
  constructor(private readonly qr: QrService) {}

  /**
   * Sin `@RequireAnyPermission`, igual que `GET /tenant/branches/:id`: el
   * cajero necesita mostrarle la escarapela al cliente en la pantalla del POS,
   * y no por eso puede tocar la configuración.
   */
  @Get(':branchId/payment-qr')
  @ApiOperation({ summary: 'Escarapela de cobro de la sede (null si no tiene)' })
  get(@CurrentTenant() ctx: TenantContext, @Param('branchId') branchId: string) {
    return this.qr.getForBranch(ctx.tenantId, branchId);
  }

  @Post(':branchId/payment-qr')
  @RequireAnyPermission(
    'restaurant:settings:write',
    'barber:settings:write',
    'retail:settings:write',
  )
  @ApiOperation({
    summary: 'Generar la escarapela de cobro',
    description:
      'Idempotente. Falla si la sede no tiene ningún medio de pago cargado.',
  })
  create(
    @CurrentTenant() ctx: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.qr.createForBranch(ctx.tenantId, branchId, ctx.userId);
  }

  @Patch(':branchId/payment-qr')
  @RequireAnyPermission(
    'restaurant:settings:write',
    'barber:settings:write',
    'retail:settings:write',
  )
  @ApiOperation({ summary: 'Estado y textos de la escarapela (no tiene destino)' })
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: UpdateQrCodeDto,
  ) {
    return this.qr.updateForBranch(ctx.tenantId, branchId, dto, ctx.userId);
  }

  @Post(':branchId/payment-qr/revoke')
  @RequireAnyPermission(
    'restaurant:settings:write',
    'barber:settings:write',
    'retail:settings:write',
  )
  @ApiOperation({
    summary: 'Revocar y generar código nuevo',
    description:
      'Para cuando el cartón impreso se fue con alguien que ya no trabaja acá.',
  })
  revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: RevokeQrCodeDto,
  ) {
    return this.qr.revokeForBranch(
      ctx.tenantId,
      branchId,
      dto.reason,
      ctx.userId,
    );
  }
}
