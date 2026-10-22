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
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import {
  UpdateAllySettingsDto,
  UpdateRetailStockCountDto,
} from './dto/retail-stock-count.dto';
import { RetailStockCountsService } from './retail-stock-counts.service';

/**
 * Revistas de bodega, escalas de aliados y el reporte de entregas. Leer va con
 * permiso de inventario; contar, cerrar y fijar escalas, con el de moverlo.
 */
@ApiTags('Retail')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('retail')
export class RetailStockCountsController {
  constructor(private readonly counts: RetailStockCountsService) {}

  @Get('ally-settings')
  @RequirePermissions('retail:inventory:read')
  allySettings(@CurrentTenant() ctx: TenantContext) {
    return this.counts.getAllySettings(ctx);
  }

  @Patch('ally-settings')
  @RequirePermissions('retail:inventory:write')
  updateAllySettings(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: UpdateAllySettingsDto,
  ) {
    return this.counts.updateAllySettings(ctx, dto);
  }

  @Get('locations/:id/counts')
  @RequirePermissions('retail:inventory:read')
  history(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.counts.listForLocation(ctx, id);
  }

  /** Abre una revista, o devuelve la que ya estaba abierta. */
  @Post('locations/:id/counts')
  @RequirePermissions('retail:inventory:write')
  open(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.counts.open(ctx, id);
  }

  @Get('locations/:id/delivered')
  @RequirePermissions('retail:inventory:read')
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  delivered(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.counts.deliveredReport(ctx, id, { from, to });
  }

  @Get('stock-counts/:countId')
  @RequirePermissions('retail:inventory:read')
  get(@CurrentTenant() ctx: TenantContext, @Param('countId') countId: string) {
    return this.counts.get(ctx, countId);
  }

  @Patch('stock-counts/:countId')
  @RequirePermissions('retail:inventory:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('countId') countId: string,
    @Body() dto: UpdateRetailStockCountDto,
  ) {
    return this.counts.update(ctx, countId, dto);
  }

  @Post('stock-counts/:countId/close')
  @RequirePermissions('retail:inventory:write')
  close(
    @CurrentTenant() ctx: TenantContext,
    @Param('countId') countId: string,
  ) {
    return this.counts.close(ctx, countId);
  }

  @Delete('stock-counts/:countId')
  @RequirePermissions('retail:inventory:write')
  cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('countId') countId: string,
  ) {
    return this.counts.cancel(ctx, countId);
  }
}
