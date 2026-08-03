import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { CreateStockMovementDto } from './dto/retail-inventory.dto';
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
  @ApiQuery({ name: 'limit', required: false, type: Number })
  movements(
    @CurrentTenant() ctx: TenantContext,
    @Query('productId') productId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.inventory.listMovements(ctx, {
      productId,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('movements')
  @RequirePermissions('retail:inventory:write')
  createMovement(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateStockMovementDto,
  ) {
    return this.inventory.createMovement(ctx, dto);
  }
}
