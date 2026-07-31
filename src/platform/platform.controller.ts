import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/types/tenant-context.interface';
import { PlatformActor } from './decorators/platform-actor.decorator';
import {
  CreatePlatformExpenseDto,
  CreatePaymentDto,
  CreateRecurringExpenseDto,
  PlatformFinanceMonthQueryDto,
  PlatformFinanceQueryDto,
  SetFeatureOverrideDto,
  SetTenantStatusDto,
  SetUserStatusDto,
  SubscriptionActionDto,
  UpdateBillingContactDto,
  UpdatePlatformExpenseDto,
  UpdatePlanDto,
  UpdatePlatformFinanceGoalDto,
  UpdateRecurringExpenseDto,
  UpdateSubscriptionDto,
  UpsertBillingContactDto,
  UpsertPlatformFinanceGoalDto,
} from './dto/platform.dto';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { PlatformService } from './platform.service';

/**
 * Backoffice de plataforma (super-admin, cross-tenant).
 * Guards: JwtAuthGuard → PlatformAdminGuard. NO usa TenantGuard ni X-Tenant-Id.
 * Toda mutación se audita (PlatformAuditLog). Ver docs/BACKOFFICE_ARCHITECTURE.md §3.
 */
@ApiTags('Platform')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  // ─── Dashboard / overview ──────────────────────────────────────────────────────

  @Get('overview')
  @ApiOperation({
    summary: 'Platform dashboard stats (tenants, MRR, payments)',
  })
  getOverview() {
    return this.platform.getOverview();
  }

  @Get('payments')
  @ApiOperation({ summary: 'Global payment history (optional ?month=YYYY-MM)' })
  @ApiQuery({ name: 'month', required: false, example: '2026-06' })
  listAllPayments(@Query('month') month?: string) {
    return this.platform.listAllPayments(month);
  }

  // ─── Finanzas internas de plataforma ─────────────────────────────────────────

  @Get('finance/dashboard')
  @ApiOperation({
    summary: 'Platform finance dashboard (revenue, expenses, goals)',
  })
  getPlatformFinanceDashboard(@Query() query: PlatformFinanceQueryDto) {
    return this.platform.getPlatformFinanceDashboard(query);
  }

  @Get('finance/income')
  @ApiOperation({
    summary:
      'Income ledger: every payment by date (cash basis) + daily series + gross/discount/net totals',
  })
  listPlatformIncome(@Query() query: PlatformFinanceQueryDto) {
    return this.platform.listPlatformIncome(query);
  }

  @Get('finance/expenses')
  @ApiOperation({ summary: 'List platform internal expenses' })
  listPlatformExpenses(@Query() query: PlatformFinanceQueryDto) {
    return this.platform.listPlatformExpenses(query);
  }

  // ─── Gastos recurrentes (compromisos) ────────────────────────────────────────

  @Get('finance/recurring-expenses')
  @ApiOperation({
    summary: 'List recurring expense commitments (infra, domains, ads…)',
  })
  @ApiQuery({ name: 'includeInactive', required: false, example: false })
  listRecurringExpenses(@Query('includeInactive') includeInactive?: string) {
    return this.platform.listRecurringExpenses(includeInactive === 'true');
  }

  @Post('finance/recurring-expenses')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a recurring expense commitment' })
  createRecurringExpense(
    @Body() dto: CreateRecurringExpenseDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.createRecurringExpense(dto, actor.id);
  }

  @Patch('finance/recurring-expenses/:id')
  @ApiOperation({ summary: 'Update a recurring expense commitment' })
  updateRecurringExpense(
    @Param('id') id: string,
    @Body() dto: UpdateRecurringExpenseDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.updateRecurringExpense(id, dto, actor.id);
  }

  @Delete('finance/recurring-expenses/:id')
  @ApiOperation({
    summary: 'Cancel a commitment (keeps the charges already paid)',
  })
  deleteRecurringExpense(
    @Param('id') id: string,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.deleteRecurringExpense(id, actor.id);
  }

  @Post('finance/recurring-expenses/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Materialize all due recurring charges as expenses',
  })
  runRecurringExpenses() {
    return this.platform.generateDueRecurringExpenses();
  }

  @Post('finance/expenses')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a platform internal expense' })
  createPlatformExpense(
    @Body() dto: CreatePlatformExpenseDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.createPlatformExpense(dto, actor.id);
  }

  @Patch('finance/expenses/:id')
  @ApiOperation({ summary: 'Update a platform internal expense' })
  updatePlatformExpense(
    @Param('id') id: string,
    @Body() dto: UpdatePlatformExpenseDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.updatePlatformExpense(id, dto, actor.id);
  }

  @Delete('finance/expenses/:id')
  @ApiOperation({ summary: 'Delete a platform internal expense' })
  deletePlatformExpense(
    @Param('id') id: string,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.deletePlatformExpense(id, actor.id);
  }

  @Get('finance/goals')
  @ApiOperation({ summary: 'List platform finance goals for a month' })
  listPlatformFinanceGoals(@Query() query: PlatformFinanceMonthQueryDto) {
    return this.platform.listPlatformFinanceGoals(query.month);
  }

  @Post('finance/goals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create or update a platform finance goal' })
  upsertPlatformFinanceGoal(
    @Body() dto: UpsertPlatformFinanceGoalDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.upsertPlatformFinanceGoal(dto, actor.id);
  }

  @Patch('finance/goals/:id')
  @ApiOperation({ summary: 'Update a platform finance goal' })
  updatePlatformFinanceGoal(
    @Param('id') id: string,
    @Body() dto: UpdatePlatformFinanceGoalDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.updatePlatformFinanceGoal(id, dto, actor.id);
  }

  @Delete('finance/goals/:id')
  @ApiOperation({ summary: 'Delete a platform finance goal' })
  deletePlatformFinanceGoal(
    @Param('id') id: string,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.deletePlatformFinanceGoal(id, actor.id);
  }

  // ─── Tenants + features ───────────────────────────────────────────────────────

  @Get('tenants')
  @ApiOperation({
    summary: 'List all tenants (status + subscription + counts)',
  })
  listTenants() {
    return this.platform.listTenants();
  }

  @Get('tenants/:id')
  @ApiOperation({ summary: 'Tenant detail + effective features' })
  getTenant(@Param('id') id: string) {
    return this.platform.getTenant(id);
  }

  @Patch('tenants/:id/plan')
  @ApiOperation({ summary: 'Change tenant plan' })
  updatePlan(
    @Param('id') id: string,
    @Body() dto: UpdatePlanDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.updatePlan(id, dto, actor.id);
  }

  @Patch('tenants/:id/features')
  @ApiOperation({ summary: 'Set a feature override (value=null removes it)' })
  setFeatureOverride(
    @Param('id') id: string,
    @Body() dto: SetFeatureOverrideDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.setFeatureOverride(id, dto, actor.id);
  }

  @Delete('tenants/:id/features')
  @ApiOperation({ summary: 'Clear all feature overrides' })
  clearOverrides(
    @Param('id') id: string,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.clearOverrides(id, actor.id);
  }

  @Get('tenants/:id/usage')
  @ApiOperation({ summary: 'Tenant usage vs plan limits' })
  getUsage(@Param('id') id: string) {
    return this.platform.getUsage(id);
  }

  @Get('tenants/:id/operations')
  @ApiOperation({
    summary: 'Read-only operational cockpit for a tenant',
    description:
      'Super-admin observability: branches, users, products, inventory, tables and recent orders without tenant impersonation.',
  })
  getTenantOperations(@Param('id') id: string) {
    return this.platform.getTenantOperations(id);
  }

  // ─── Estado de cuenta ───────────────────────────────────────────────────────

  @Patch('tenants/:id/status')
  @ApiOperation({ summary: 'Set tenant operational status' })
  setTenantStatus(
    @Param('id') id: string,
    @Body() dto: SetTenantStatusDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.setTenantStatus(id, dto, actor.id);
  }

  // ─── Usuarios del tenant ──────────────────────────────────────────────────────

  @Get('tenants/:id/users')
  @ApiOperation({ summary: 'List users of a tenant' })
  listTenantUsers(@Param('id') id: string) {
    return this.platform.listTenantUsers(id);
  }

  @Patch('users/:id/status')
  @ApiOperation({ summary: 'Enable/disable a user (ACTIVE | DISABLED)' })
  setUserStatus(
    @Param('id') id: string,
    @Body() dto: SetUserStatusDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.setUserStatus(id, dto.status, actor.id);
  }

  // ─── Suscripción ──────────────────────────────────────────────────────────────

  @Get('tenants/:id/subscription')
  @ApiOperation({ summary: 'Get tenant subscription' })
  getSubscription(@Param('id') id: string) {
    return this.platform.getSubscription(id);
  }

  @Patch('tenants/:id/subscription')
  @ApiOperation({ summary: 'Update subscription commercial fields' })
  updateSubscription(
    @Param('id') id: string,
    @Body() dto: UpdateSubscriptionDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.updateSubscription(id, dto, actor.id);
  }

  @Post('tenants/:id/subscription/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate subscription (→ tenant ACTIVE)' })
  activateSubscription(
    @Param('id') id: string,
    @Body() dto: SubscriptionActionDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.setSubscriptionStatus(
      id,
      'activate',
      actor.id,
      dto.reason,
    );
  }

  @Post('tenants/:id/subscription/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend subscription (→ tenant SUSPENDED)' })
  suspendSubscription(
    @Param('id') id: string,
    @Body() dto: SubscriptionActionDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.setSubscriptionStatus(
      id,
      'suspend',
      actor.id,
      dto.reason,
    );
  }

  @Post('tenants/:id/subscription/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel subscription (→ tenant INACTIVE)' })
  cancelSubscription(
    @Param('id') id: string,
    @Body() dto: SubscriptionActionDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.setSubscriptionStatus(
      id,
      'cancel',
      actor.id,
      dto.reason,
    );
  }

  // ─── Pagos / facturación ────────────────────────────────────────────────────────

  @Get('tenants/:id/payments')
  @ApiOperation({ summary: 'Payment history of a tenant' })
  listPayments(@Param('id') id: string) {
    return this.platform.listPayments(id);
  }

  @Post('tenants/:id/payments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a payment (manual). extendPeriod=true → advance payment',
  })
  createPayment(
    @Param('id') id: string,
    @Body() dto: CreatePaymentDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.createPayment(id, dto, actor.id);
  }

  // ─── Contactos de cobro ─────────────────────────────────────────────────────────

  @Get('tenants/:id/billing-contacts')
  @ApiOperation({ summary: 'List billing contacts of a tenant' })
  listBillingContacts(@Param('id') id: string) {
    return this.platform.listBillingContacts(id);
  }

  @Post('tenants/:id/billing-contacts')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a billing contact' })
  createBillingContact(
    @Param('id') id: string,
    @Body() dto: UpsertBillingContactDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.createBillingContact(id, dto, actor.id);
  }

  @Patch('tenants/:id/billing-contacts/:contactId')
  @ApiOperation({ summary: 'Update a billing contact' })
  updateBillingContact(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @Body() dto: UpdateBillingContactDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.updateBillingContact(id, contactId, dto, actor.id);
  }

  @Delete('tenants/:id/billing-contacts/:contactId')
  @ApiOperation({ summary: 'Delete a billing contact' })
  deleteBillingContact(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.platform.deleteBillingContact(id, contactId, actor.id);
  }
}
