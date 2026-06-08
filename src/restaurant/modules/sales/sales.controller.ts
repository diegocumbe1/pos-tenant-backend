import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { SalesService } from './sales.service';
import { CreateClaimDto } from './dto/create-claim.dto';

@ApiTags('Sales')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('restaurant/sales')
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Get()
  @RequirePermissions('restaurant:sales:read')
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'terminalId', required: false })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('terminalId') terminalId?: string,
  ) {
    return this.salesService.list(ctx, from, to, terminalId);
  }

  @Get('daily')
  @RequirePermissions('restaurant:sales:read')
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  daily(
    @CurrentTenant() ctx: TenantContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.salesService.daily(ctx, from, to);
  }

  @Get(':id')
  @RequirePermissions('restaurant:sales:read')
  findOne(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.salesService.findOne(ctx, id);
  }
}

/** Reclamos: sirven durante el servicio y sobre venta cerrada (por orderId). */
@ApiTags('Order Claims')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('restaurant/orders')
export class OrderClaimsController {
  constructor(private readonly salesService: SalesService) {}

  @Post(':id/claims')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('restaurant:claims:create')
  addClaim(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CreateClaimDto,
  ) {
    return this.salesService.addClaim(ctx, id, dto);
  }
}
