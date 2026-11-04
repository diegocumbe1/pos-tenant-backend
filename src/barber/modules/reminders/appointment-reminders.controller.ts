import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequireAnyPermission } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { AppointmentRemindersService } from './appointment-reminders.service';
import { PauseNotificationsDto, UpsertReminderRuleDto } from './dto';

// Quien tiene la pantalla de su vertical puede ajustar sus avisos; lo del equipo lo
// valida el servicio.
@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@RequireAnyPermission('barber:appointments:read', 'retail:sales:read')
@Controller('notifications/rules')
export class AppointmentRemindersController {
  constructor(private readonly reminders: AppointmentRemindersService) {}

  @Get()
  overview(@CurrentTenant() ctx: TenantContext) {
    return this.reminders.overview(ctx);
  }

  @Put('me')
  saveMine(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: UpsertReminderRuleDto,
  ) {
    return this.reminders.saveMine(ctx, dto);
  }

  @Delete('me')
  resetMine(@CurrentTenant() ctx: TenantContext) {
    return this.reminders.resetMine(ctx);
  }

  @Put('pause')
  pause(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: PauseNotificationsDto,
  ) {
    return this.reminders.pause(ctx, dto);
  }

  @Delete('pause')
  resume(@CurrentTenant() ctx: TenantContext) {
    return this.reminders.resume(ctx);
  }

  @Put('users/:userId')
  saveUser(
    @CurrentTenant() ctx: TenantContext,
    @Param('userId') userId: string,
    @Body() dto: UpsertReminderRuleDto,
  ) {
    return this.reminders.saveUser(ctx, userId, dto);
  }

  @Delete('users/:userId')
  resetUser(
    @CurrentTenant() ctx: TenantContext,
    @Param('userId') userId: string,
  ) {
    return this.reminders.resetUser(ctx, userId);
  }

  @Put('roles/:roleCode')
  saveRole(
    @CurrentTenant() ctx: TenantContext,
    @Param('roleCode') roleCode: string,
    @Body() dto: UpsertReminderRuleDto,
  ) {
    return this.reminders.saveRole(ctx, roleCode, dto);
  }
}
