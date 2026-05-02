import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../auth/guards/password-set.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { BarberService } from './barber.service';
import {
  CancelBarberAppointmentDto,
  CreateBarberAppointmentDto,
  UpdateBarberAppointmentDto,
} from './dto/barber-appointment.dto';
import {
  CreateBarberCustomerDto,
  UpdateBarberCustomerDto,
} from './dto/barber-customer.dto';
import {
  CreateBarberServiceDto,
  UpdateBarberServiceDto,
} from './dto/barber-service.dto';
import { UpdateBarberSettingsDto } from './dto/barber-settings.dto';
import {
  CreateBarberStaffDto,
  UpdateBarberStaffDto,
} from './dto/barber-staff.dto';

@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('barber')
export class BarberController {
  constructor(private readonly barberService: BarberService) {}

  @Get('settings')
  @RequirePermissions('barber:settings:read')
  getSettings(@CurrentTenant() ctx: TenantContext) {
    return this.barberService.getSettings(ctx);
  }

  @Patch('settings')
  @RequirePermissions('barber:settings:write')
  updateSettings(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: UpdateBarberSettingsDto,
  ) {
    return this.barberService.updateSettings(ctx, dto);
  }

  @Get('services')
  @RequirePermissions('barber:services:read')
  listServices(@CurrentTenant() ctx: TenantContext) {
    return this.barberService.listServices(ctx);
  }

  @Post('services')
  @RequirePermissions('barber:services:write')
  createService(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateBarberServiceDto,
  ) {
    return this.barberService.createService(ctx, dto);
  }

  @Patch('services/:id')
  @RequirePermissions('barber:services:write')
  updateService(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateBarberServiceDto,
  ) {
    return this.barberService.updateService(ctx, id, dto);
  }

  @Delete('services/:id')
  @RequirePermissions('barber:services:write')
  deleteService(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.barberService.deleteService(ctx, id);
  }

  @Get('staff')
  @RequirePermissions('barber:staff:read')
  listStaff(@CurrentTenant() ctx: TenantContext) {
    return this.barberService.listStaff(ctx);
  }

  @Post('staff')
  @RequirePermissions('barber:staff:write')
  createStaff(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateBarberStaffDto,
  ) {
    return this.barberService.createStaff(ctx, dto);
  }

  @Patch('staff/:id')
  @RequirePermissions('barber:staff:write')
  updateStaff(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateBarberStaffDto,
  ) {
    return this.barberService.updateStaff(ctx, id, dto);
  }

  @Delete('staff/:id')
  @RequirePermissions('barber:staff:write')
  deleteStaff(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.barberService.deleteStaff(ctx, id);
  }

  @Get('customers')
  @RequirePermissions('barber:customers:read')
  listCustomers(@CurrentTenant() ctx: TenantContext) {
    return this.barberService.listCustomers(ctx);
  }

  @Post('customers')
  @RequirePermissions('barber:customers:write')
  createCustomer(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateBarberCustomerDto,
  ) {
    return this.barberService.createCustomer(ctx, dto);
  }

  @Patch('customers/:id')
  @RequirePermissions('barber:customers:write')
  updateCustomer(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateBarberCustomerDto,
  ) {
    return this.barberService.updateCustomer(ctx, id, dto);
  }

  @Get('appointments')
  @RequirePermissions('barber:appointments:read')
  listAppointments(@CurrentTenant() ctx: TenantContext) {
    return this.barberService.listAppointments(ctx);
  }

  @Post('appointments')
  @RequirePermissions('barber:appointments:write')
  createAppointment(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateBarberAppointmentDto,
  ) {
    return this.barberService.createAppointment(ctx, dto);
  }

  @Patch('appointments/:id')
  @RequirePermissions('barber:appointments:write')
  updateAppointment(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateBarberAppointmentDto,
  ) {
    return this.barberService.updateAppointment(ctx, id, dto);
  }

  @Patch('appointments/:id/cancel')
  @RequirePermissions('barber:appointments:write')
  cancelAppointment(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CancelBarberAppointmentDto,
  ) {
    return this.barberService.cancelAppointment(ctx, id, dto);
  }
}
