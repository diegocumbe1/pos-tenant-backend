import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../auth/guards/password-set.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { CashClosingsService } from './cash-closings.service';
import {
  AssignAccountDto,
  ClosingPreviewDto,
  CreateClosingDto,
  CreateMoneyAccountDto,
  CreateTransferDto,
  UpdateMoneyAccountDto,
} from './dto/cash-closing.dto';

@ApiTags('Finance')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@RequirePermissions('restaurant:finance:read')
@Controller('finance/cash')
export class CashClosingsController {
  constructor(private readonly cash: CashClosingsService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Caja real: cuentas, saldos, cierres e histórico por mes',
  })
  overview(@CurrentTenant() ctx: TenantContext) {
    return this.cash.overview(ctx);
  }

  @Post('accounts')
  @RequirePermissions('restaurant:finance:write')
  createAccount(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateMoneyAccountDto,
  ) {
    return this.cash.createAccount(ctx, dto);
  }

  @Patch('accounts/:id')
  @RequirePermissions('restaurant:finance:write')
  updateAccount(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateMoneyAccountDto,
  ) {
    return this.cash.updateAccount(ctx, id, dto);
  }

  @Post('closings/preview')
  @RequirePermissions('restaurant:finance:write')
  @ApiOperation({ summary: 'Compara lo contado con lo esperado, sin guardar' })
  preview(@CurrentTenant() ctx: TenantContext, @Body() dto: ClosingPreviewDto) {
    return this.cash.preview(ctx, dto);
  }

  @Post('closings')
  @RequirePermissions('restaurant:finance:write')
  createClosing(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateClosingDto,
  ) {
    return this.cash.create(ctx, dto);
  }

  @Get('closings/:id')
  closing(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.cash.detail(ctx, id);
  }

  @Delete('closings/:id')
  @RequirePermissions('restaurant:finance:write')
  removeClosing(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.cash.remove(ctx, id);
  }

  @Post('closings/:id/assume-shortage')
  @RequirePermissions('restaurant:finance:write')
  @ApiOperation({ summary: 'Asume el faltante como gasto "Faltante de caja"' })
  assumeShortage(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.cash.assumeShortage(ctx, id);
  }

  @Put('assign')
  @RequirePermissions('restaurant:finance:write')
  assign(@CurrentTenant() ctx: TenantContext, @Body() dto: AssignAccountDto) {
    return this.cash.assign(ctx, dto);
  }

  @Post('transfers')
  @RequirePermissions('restaurant:finance:write')
  createTransfer(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateTransferDto,
  ) {
    return this.cash.createTransfer(ctx, dto);
  }

  @Delete('transfers/:id')
  @RequirePermissions('restaurant:finance:write')
  removeTransfer(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.cash.removeTransfer(ctx, id);
  }
}
