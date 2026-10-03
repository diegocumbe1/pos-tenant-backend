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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PasswordSetGuard } from '../auth/guards/password-set.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { FinanceService } from './finance.service';
import { ExpenseTemplatesService } from './expense-templates.service';
import { CapitalService } from './capital.service';
import {
  CreateCapitalMovementDto,
  SetExpenseFundingDto,
  UpdateCapitalMovementDto,
} from './dto/capital.dto';
import { PlatformSubscriptionExpenseService } from './platform-subscription-expense.service';
import {
  CreateExpenseTemplateDto,
  PayExpenseOccurrenceDto,
  SkipExpenseOccurrenceDto,
  UpdateExpenseTemplateDto,
} from './dto/expense-template.dto';
import { PeriodQueryDto } from './dto/period-query.dto';
import { PayrollQueryDto } from './dto/payroll-query.dto';
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
  constructor(
    private readonly financeService: FinanceService,
    private readonly expenseTemplates: ExpenseTemplatesService,
    private readonly platformSubscription: PlatformSubscriptionExpenseService,
    private readonly capital: CapitalService,
  ) {}

  // ─── Inversión: capital del dueño ──────────────────────────────────────────

  @Get('capital/summary')
  @ApiOperation({
    summary:
      'Inversión: invertido, reinvertido, ganancia, recuperación, respaldo y cuánto se puede retirar',
  })
  capitalSummary(@CurrentTenant() ctx: TenantContext) {
    return this.capital.summary(ctx);
  }

  @Get('capital/movements')
  listCapitalMovements(@CurrentTenant() ctx: TenantContext) {
    return this.capital.list(ctx);
  }

  @Post('capital/movements')
  @RequirePermissions('restaurant:finance:write')
  createCapitalMovement(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateCapitalMovementDto,
  ) {
    return this.capital.create(ctx, dto);
  }

  @Patch('capital/movements/:id')
  @RequirePermissions('restaurant:finance:write')
  updateCapitalMovement(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateCapitalMovementDto,
  ) {
    return this.capital.update(ctx, id, dto);
  }

  /** Cuánto de un gasto salió de las ventas (reinversión declarada). */
  @Put('capital/expenses/:expenseId/funding')
  @RequirePermissions('restaurant:finance:write')
  setExpenseFunding(
    @CurrentTenant() ctx: TenantContext,
    @Param('expenseId') expenseId: string,
    @Body() dto: SetExpenseFundingDto,
  ) {
    return this.capital.setExpenseFunding(ctx, expenseId, dto.fromSalesCOP);
  }

  @Delete('capital/movements/:id')
  @RequirePermissions('restaurant:finance:write')
  removeCapitalMovement(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    return this.capital.remove(ctx, id);
  }

  // ─── Gastos recurrentes ────────────────────────────────────────────────────

  @Get('expense-templates')
  listExpenseTemplates(@CurrentTenant() ctx: TenantContext) {
    return this.expenseTemplates.list(ctx);
  }

  @Get('expenses/due')
  @ApiOperation({
    summary:
      'Ocurrencias de gastos recurrentes por pagar: vencidas, de esta semana y del próximo mes',
  })
  dueExpenses(@CurrentTenant() ctx: TenantContext) {
    return this.expenseTemplates.due(ctx);
  }

  @Post('expense-templates')
  @RequirePermissions('restaurant:finance:write')
  createExpenseTemplate(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateExpenseTemplateDto,
  ) {
    return this.expenseTemplates.create(ctx, dto);
  }

  @Patch('expense-templates/:id')
  @RequirePermissions('restaurant:finance:write')
  updateExpenseTemplate(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateExpenseTemplateDto,
  ) {
    return this.expenseTemplates.update(ctx, id, dto);
  }

  @Delete('expense-templates/:id')
  @RequirePermissions('restaurant:finance:write')
  removeExpenseTemplate(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    return this.expenseTemplates.remove(ctx, id);
  }

  @Post('expense-templates/:id/pay')
  @RequirePermissions('restaurant:finance:write')
  payExpenseOccurrence(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: PayExpenseOccurrenceDto,
  ) {
    return this.expenseTemplates.pay(ctx, id, dto);
  }

  @Post('expense-templates/:id/skip')
  @RequirePermissions('restaurant:finance:write')
  skipExpenseOccurrence(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: SkipExpenseOccurrenceDto,
  ) {
    return this.expenseTemplates.skip(ctx, id, dto.occurrence);
  }

  // ─── Suscripción a Lynko como gasto (la gestiona el dueño) ─────────────────

  @Get('platform-subscription')
  @ApiOperation({
    summary:
      'Lo que Lynko le cobró a este negocio, para registrarlo como gasto. null = sin suscripción',
  })
  platformSubscriptionSummary(@CurrentTenant() ctx: TenantContext) {
    return this.platformSubscription.summary(ctx);
  }

  @Post('platform-subscription/payments/:paymentId/register')
  @RequirePermissions('restaurant:finance:write')
  registerPlatformPayment(
    @CurrentTenant() ctx: TenantContext,
    @Param('paymentId') paymentId: string,
  ) {
    return this.platformSubscription.registerPayment(ctx, paymentId);
  }

  @Get('dashboard')
  dashboard(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: PeriodQueryDto,
  ) {
    return this.financeService.dashboard(ctx, query);
  }

  @Get('cash-balance')
  @ApiOperation({
    summary: 'Saldo de caja del período (solo lectura sobre CashSession)',
  })
  cashBalance(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: PeriodQueryDto,
  ) {
    return this.financeService.cashBalance(ctx, query);
  }

  @Get('cashflow')
  @ApiOperation({
    summary:
      'Flujo de caja real: entradas, salidas y saldo acumulado desde el primer movimiento',
  })
  cashflow(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: PeriodQueryDto,
  ) {
    return this.financeService.cashflow(ctx, query);
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
    @Query() query: PayrollQueryDto,
  ) {
    return this.financeService.payroll(ctx, query);
  }

  @Get('goals')
  goals(@CurrentTenant() ctx: TenantContext, @Query() query: PeriodQueryDto) {
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
  removeExpense(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
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
  removePayroll(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
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
  removeGoal(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.financeService.removeGoal(ctx, id);
  }
}
