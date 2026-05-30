import {
  Body,
  Controller,
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
  UpdateBarberAppointmentDto,
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

  @Patch(':id/cancel')
  @RequirePermissions('barber:appointments:write')
  cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CancelBarberAppointmentDto,
  ) {
    return this.appointmentsService.cancelAppointment(ctx, id, dto);
  }
}
