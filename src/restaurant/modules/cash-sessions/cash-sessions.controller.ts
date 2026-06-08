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
import { CashSessionsService } from './cash-sessions.service';
import {
  CloseCashSessionDto,
  CreateCashMovementDto,
  OpenCashSessionDto,
} from './dto/cash-session.dto';

@ApiTags('Cash Sessions')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('restaurant/cash-sessions')
export class CashSessionsController {
  constructor(private readonly cashSessionsService: CashSessionsService) {}

  @Post('open')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('restaurant:cash:manage')
  open(@CurrentTenant() ctx: TenantContext, @Body() dto: OpenCashSessionDto) {
    return this.cashSessionsService.open(ctx, dto);
  }

  @Get('current')
  @RequirePermissions('restaurant:cash:read')
  @ApiQuery({ name: 'terminalId', required: false })
  current(
    @CurrentTenant() ctx: TenantContext,
    @Query('terminalId') terminalId?: string,
  ) {
    return this.cashSessionsService.current(ctx, terminalId);
  }

  @Get()
  @RequirePermissions('restaurant:cash:read')
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.cashSessionsService.list(ctx, from, to);
  }

  @Get(':id')
  @RequirePermissions('restaurant:cash:read')
  findOne(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.cashSessionsService.findOne(ctx, id);
  }

  @Get(':id/movements')
  @RequirePermissions('restaurant:cash:read')
  movements(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.cashSessionsService.movements(ctx, id);
  }

  @Post(':id/movements')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('restaurant:cash:manage')
  addMovement(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CreateCashMovementDto,
  ) {
    return this.cashSessionsService.addMovement(ctx, id, dto);
  }

  @Get(':id/summary')
  @RequirePermissions('restaurant:cash:read')
  summary(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.cashSessionsService.summary(ctx, id);
  }

  @Get(':id/report')
  @RequirePermissions('restaurant:cash:read')
  report(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.cashSessionsService.report(ctx, id);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('restaurant:cash:manage')
  close(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CloseCashSessionDto,
  ) {
    return this.cashSessionsService.close(ctx, id, dto);
  }
}
