import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PasswordSetGuard } from '../auth/guards/password-set.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { FinanceService } from './finance.service';
import { PeriodQueryDto } from './dto/period-query.dto';

@ApiTags('Finance')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@RequirePermissions('restaurant:finance:read')
@Controller('finance')
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  @Get('dashboard')
  dashboard(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: PeriodQueryDto,
  ) {
    return this.financeService.dashboard(ctx, query);
  }

  @Get('expenses')
  expenses(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: PeriodQueryDto,
  ) {
    return this.financeService.expenses(ctx, query);
  }

  @Get('payroll')
  payroll(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: PeriodQueryDto,
  ) {
    return this.financeService.payroll(ctx, query);
  }

  @Get('goals')
  goals(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: PeriodQueryDto,
  ) {
    return this.financeService.goals(ctx, query);
  }
}
