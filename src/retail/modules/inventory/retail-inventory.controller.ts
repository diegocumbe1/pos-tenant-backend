import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { RetailStockMovementType } from '@prisma/client';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import {
  CreateRetailStockMovementDto,
  SetVariantDistributionDto,
} from './dto/retail-inventory.dto';
import { RetailInventoryService } from './retail-inventory.service';

@ApiTags('Retail')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('retail/inventory')
export class RetailInventoryController {
  constructor(private readonly inventory: RetailInventoryService) {}

  @Get('summary')
  @RequirePermissions('retail:inventory:read')
  summary(@CurrentTenant() ctx: TenantContext) {
    return this.inventory.getSummary(ctx);
  }

  @Get('movements')
  @RequirePermissions('retail:inventory:read')
  @ApiQuery({ name: 'productId', required: false })
  @ApiQuery({ name: 'locationId', required: false })
  @ApiQuery({ name: 'type', required: false, enum: RetailStockMovementType })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  movements(
    @CurrentTenant() ctx: TenantContext,
    @Query('productId') productId?: string,
    @Query('locationId') locationId?: string,
    @Query('type') type?: RetailStockMovementType,
    @Query('limit') limit?: string,
  ) {
    return this.inventory.listMovements(ctx, {
      productId,
      locationId,
      type,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /** Compras, ventas, movimientos y cambios de precio de un producto, en orden. */
  @Get('products/:productId/history')
  @RequirePermissions('retail:inventory:read')
  @ApiQuery({ name: 'limit', required: false, type: Number })
  productHistory(
    @CurrentTenant() ctx: TenantContext,
    @Param('productId') productId: string,
    @Query('limit') limit?: string,
  ) {
    return this.inventory.productHistory(ctx, productId, {
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('movements')
  @RequirePermissions('retail:inventory:write')
  createMovement(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateRetailStockMovementDto,
  ) {
    return this.inventory.createMovement(ctx, dto);
  }

  /**
   * Reparte el total entre los valores del grupo que lleva existencias.
   *
   * PUT y no POST porque es idempotente: manda el conteo que debe quedar, no un
   * delta. Reenviarlo dos veces deja el mismo resultado.
   */
  @Put('products/:productId/distribution')
  @RequirePermissions('retail:inventory:write')
  setDistribution(
    @CurrentTenant() ctx: TenantContext,
    @Param('productId') productId: string,
    @Body() dto: SetVariantDistributionDto,
  ) {
    return this.inventory.setDistribution(ctx, productId, dto);
  }
}
