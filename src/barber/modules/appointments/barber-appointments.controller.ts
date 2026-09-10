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
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { BarberAppointmentsService } from './barber-appointments.service';
import {
  CancelBarberAppointmentDto,
  CreateBarberAppointmentDto,
  RejectBarberAppointmentDto,
  UpdateBarberAppointmentDto,
  UpdateBarberAppointmentServedAtDto,
} from './dto/barber-appointment.dto';

@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('barber/appointments')
export class BarberAppointmentsController {
  constructor(
    private readonly appointmentsService: BarberAppointmentsService,
  ) {}

  @Get()
  @RequirePermissions('barber:appointments:read')
  list(@CurrentTenant() ctx: TenantContext) {
    return this.appointmentsService.listAppointments(ctx);
  }

  @Post()
  @RequirePermissions('barber:appointments:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateBarberAppointmentDto,
  ) {
    return this.appointmentsService.createAppointment(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('barber:appointments:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateBarberAppointmentDto,
  ) {
    return this.appointmentsService.updateAppointment(ctx, id, dto);
  }

  // Corrige el día en que se prestó el servicio ("lo registré hoy pero fue hace
  // ocho días"). Deja rastro en el histórico de la cita.
  @Patch(':id/served-at')
  @RequirePermissions('barber:appointments:write')
  updateServedAt(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateBarberAppointmentServedAtDto,
  ) {
    return this.appointmentsService.updateServedAt(ctx, id, dto);
  }

  // Histórico auditable: quién cambió qué y cuándo.
  @Get(':id/events')
  @RequirePermissions('barber:appointments:read')
  events(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.appointmentsService.listEvents(ctx, id);
  }

  @Patch(':id/cancel')
  @RequirePermissions('barber:appointments:write')
  cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CancelBarberAppointmentDto,
  ) {
    return this.appointmentsService.cancelAppointment(ctx, id, dto);
  }

  @Patch(':id/approve')
  @RequirePermissions('barber:appointments:write')
  approve(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.appointmentsService.approveAppointment(ctx, id);
  }

  @Patch(':id/reject')
  @RequirePermissions('barber:appointments:write')
  reject(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: RejectBarberAppointmentDto,
  ) {
    return this.appointmentsService.rejectAppointment(ctx, id, dto.reason);
  }

  @Delete(':id')
  @RequirePermissions('barber:appointments:write')
  remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.appointmentsService.deleteAppointment(ctx, id);
  }
}
