import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import {
  AssignRetailStockLotDto,
  CreateRetailStockLotDto,
  UpdateRetailSettingsDto,
  UpdateRetailStockLotDto,
} from './dto/retail-inventory.dto';
import { RetailExpiryService } from './retail-expiry.service';

/**
 * Vencimientos de la tienda. Todo va con `retail:inventory:expiry`, que por
 * defecto solo tiene el dueño: "la alerta la ve solo el admin". El mostrador
 * igual ve la fecha más cercana de cada producto, porque viaja en el catálogo.
 */
@ApiTags('Retail')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('retail/expiry')
export class RetailExpiryController {
  constructor(private readonly expiry: RetailExpiryService) {}

  /**
   * Los días de aviso. Lectura con `retail:inventory:read` y no con el permiso
   * de vencimientos: el mostrador los necesita para marcar "vence pronto".
   */
  @Get('settings')
  @RequirePermissions('retail:inventory:read')
  settings(@CurrentTenant() ctx: TenantContext) {
    return this.expiry.getSettings(ctx);
  }

  @Patch('settings')
  @RequirePermissions('retail:inventory:expiry')
  updateSettings(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: UpdateRetailSettingsDto,
  ) {
    return this.expiry.updateSettings(ctx, dto);
  }

  @Get('lots')
  @RequirePermissions('retail:inventory:expiry')
  @ApiQuery({
    name: 'all',
    required: false,
    type: Boolean,
    description:
      'true = todos los lotes; por defecto solo vencidos y por vencer',
  })
  lots(@CurrentTenant() ctx: TenantContext, @Query('all') all?: string) {
    return this.expiry.listLots(ctx, all !== 'true');
  }

  /**
   * Las fechas disponibles de un producto, para elegir en el mostrador cuál se
   * vende o se entrega. Con permiso de vender, no de vencimientos: el cajero
   * tiene que poder decir qué unidad tomó del estante. Solo lee.
   */
  @Get('products/:productId/available')
  @RequireAnyPermission('retail:sales:write', 'retail:inventory:expiry')
  availableLots(
    @CurrentTenant() ctx: TenantContext,
    @Param('productId') productId: string,
  ) {
    return this.expiry.productLots(ctx, productId);
  }

  @Get('products/:productId')
  @RequirePermissions('retail:inventory:expiry')
  productLots(
    @CurrentTenant() ctx: TenantContext,
    @Param('productId') productId: string,
  ) {
    return this.expiry.productLots(ctx, productId);
  }

  @Post('lots')
  @RequirePermissions('retail:inventory:expiry')
  createLot(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateRetailStockLotDto,
  ) {
    return this.expiry.createLot(ctx, dto);
  }

  @Post('lots/:id/assign')
  @RequirePermissions('retail:inventory:expiry')
  assignLot(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: AssignRetailStockLotDto,
  ) {
    return this.expiry.assignLot(ctx, id, dto);
  }

  @Patch('lots/:id')
  @RequirePermissions('retail:inventory:expiry')
  updateLot(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateRetailStockLotDto,
  ) {
    return this.expiry.updateLot(ctx, id, dto);
  }

  @Delete('lots/:id')
  @RequirePermissions('retail:inventory:expiry')
  deleteLot(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.expiry.deleteLot(ctx, id);
  }
}
