import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
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
  CreateRetailLocationDto,
  CreateRetailTransferDto,
  SetLocationCountDto,
  UpdateRetailLocationDto,
} from './dto/retail-location.dto';
import { RetailLocationsService } from './retail-locations.service';

@ApiTags('Retail')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('retail/locations')
export class RetailLocationsController {
  constructor(private readonly locations: RetailLocationsService) {}

  @Get()
  @RequirePermissions('retail:inventory:read')
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.locations.list(ctx, {
      includeInactive: includeInactive === 'true',
    });
  }

  @Post()
  @RequirePermissions('retail:inventory:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateRetailLocationDto,
  ) {
    return this.locations.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('retail:inventory:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateRetailLocationDto,
  ) {
    return this.locations.update(ctx, id, dto);
  }

  /**
   * DELETE desactiva, no borra: el kardex de la bodega tiene que sobrevivir. Lo
   * que quedaba allá vuelve a la principal como traslado.
   */
  @Delete(':id')
  @RequirePermissions('retail:inventory:write')
  deactivate(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.locations.deactivate(ctx, id);
  }

  @Post('transfers')
  @RequirePermissions('retail:inventory:write')
  transfer(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateRetailTransferDto,
  ) {
    return this.locations.transfer(ctx, dto);
  }

  /** PUT porque es idempotente: manda el saldo que debe quedar, no un delta. */
  @Put(':id/count')
  @RequirePermissions('retail:inventory:write')
  setCount(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: SetLocationCountDto,
  ) {
    return this.locations.setCount(ctx, id, dto);
  }

  /** Qué hay en una bodega, producto por producto. La vista del conteo físico. */
  @Get(':id/stock')
  @RequirePermissions('retail:inventory:read')
  stock(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.locations.locationStock(ctx, id);
  }

  /** Dónde está cada unidad de un producto. */
  @Get('products/:productId')
  @RequirePermissions('retail:inventory:read')
  breakdown(
    @CurrentTenant() ctx: TenantContext,
    @Param('productId') productId: string,
  ) {
    return this.locations.productBreakdown(ctx, productId);
  }
}
