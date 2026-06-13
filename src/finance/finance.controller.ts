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
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';
import { CreatePayrollDto, UpdatePayrollDto } from './dto/payroll.dto';
import {
  CreateFinanceGoalDto,
  UpdateFinanceGoalDto,
} from './dto/finance-goal.dto';

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

  // ─── Gastos ────────────────────────────────────────────────────────────────

  @Post('expenses')
  @RequirePermissions('restaurant:finance:write')
  createExpense(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateExpenseDto,
  ) {
    return this.financeService.createExpense(ctx, dto);
  }

  @Patch('expenses/:id')
  @RequirePermissions('restaurant:finance:write')
  updateExpense(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateExpenseDto,
  ) {
    return this.financeService.updateExpense(ctx, id, dto);
  }

  @Delete('expenses/:id')
  @RequirePermissions('restaurant:finance:write')
  removeExpense(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    return this.financeService.removeExpense(ctx, id);
  }

  // ─── Nómina ────────────────────────────────────────────────────────────────

  @Post('payroll')
  @RequirePermissions('restaurant:finance:write')
  createPayroll(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreatePayrollDto,
  ) {
    return this.financeService.createPayroll(ctx, dto);
  }

  @Patch('payroll/:id')
  @RequirePermissions('restaurant:finance:write')
  updatePayroll(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdatePayrollDto,
  ) {
    return this.financeService.updatePayroll(ctx, id, dto);
  }

  @Delete('payroll/:id')
  @RequirePermissions('restaurant:finance:write')
  removePayroll(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    return this.financeService.removePayroll(ctx, id);
  }

  // ─── Metas ─────────────────────────────────────────────────────────────────

  @Post('goals')
  @RequirePermissions('restaurant:finance:write')
  createGoal(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateFinanceGoalDto,
  ) {
    return this.financeService.createGoal(ctx, dto);
  }

  @Patch('goals/:id')
  @RequirePermissions('restaurant:finance:write')
  updateGoal(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateFinanceGoalDto,
  ) {
    return this.financeService.updateGoal(ctx, id, dto);
  }

  @Delete('goals/:id')
  @RequirePermissions('restaurant:finance:write')
  removeGoal(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    return this.financeService.removeGoal(ctx, id);
  }
}
