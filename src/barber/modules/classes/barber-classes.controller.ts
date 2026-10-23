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
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { BarberClassesService } from './barber-classes.service';
import {
  AddBarberClassAttendeeDto,
  BarberClassSessionRefDto,
  CreateBarberClassEnrollmentDto,
  CreateBarberClassScheduleDto,
  ListBarberClassSchedulesQueryDto,
  ListBarberClassSessionsQueryDto,
  MarkBarberClassAttendanceDto,
  SetBarberClassAttendeeDto,
  UpdateBarberClassScheduleDto,
  UpdateBarberClassSessionDto,
} from './dto/barber-class.dto';

// Clases grupales: horarios fijos, inscripción fija, inscritos y asistencia.
// Mismos permisos de la agenda: las clases son agenda.
@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('barber/classes')
export class BarberClassesController {
  constructor(private readonly classes: BarberClassesService) {}

  @Get('schedules')
  @RequirePermissions('barber:appointments:read')
  listSchedules(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: ListBarberClassSchedulesQueryDto,
  ) {
    return this.classes.listSchedules(ctx, query.history === 'true');
  }

  @Post('schedules')
  @RequirePermissions('barber:appointments:write')
  createSchedules(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateBarberClassScheduleDto,
  ) {
    return this.classes.createSchedules(ctx, dto);
  }

  @Patch('schedules/:id')
  @RequirePermissions('barber:appointments:write')
  updateSchedule(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateBarberClassScheduleDto,
  ) {
    return this.classes.updateSchedule(ctx, id, dto);
  }

  @Post('schedules/:id/archive')
  @RequirePermissions('barber:appointments:write')
  archiveSchedule(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    return this.classes.archiveSchedule(ctx, id);
  }

  @Post('schedules/:id/restore')
  @RequirePermissions('barber:appointments:write')
  restoreSchedule(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    return this.classes.restoreSchedule(ctx, id);
  }

  // Borrar de verdad: solo si nunca tuvo clases con gente (si no, archivar).
  @Delete('schedules/:id')
  @RequirePermissions('barber:appointments:write')
  deleteSchedule(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.classes.deleteSchedule(ctx, id);
  }

  @Get('schedules/:id/events')
  @RequirePermissions('barber:appointments:read')
  scheduleEvents(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.classes.listScheduleEvents(ctx, id);
  }

  // Los horarios fijos de un cliente (para su ficha).
  @Get('enrollments')
  @RequirePermissions('barber:appointments:read')
  customerEnrollments(
    @CurrentTenant() ctx: TenantContext,
    @Query('customerId') customerId: string,
  ) {
    return this.classes.customerEnrollments(ctx, customerId);
  }

  @Post('schedules/:id/enrollments')
  @RequirePermissions('barber:appointments:write')
  enroll(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CreateBarberClassEnrollmentDto,
  ) {
    return this.classes.enroll(ctx, id, dto);
  }

  @Patch('enrollments/:id/end')
  @RequirePermissions('barber:appointments:write')
  unenroll(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.classes.unenroll(ctx, id);
  }

  @Get('sessions')
  @RequirePermissions('barber:appointments:read')
  listSessions(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: ListBarberClassSessionsQueryDto,
  ) {
    return this.classes.listSessions(ctx, query.from, query.to);
  }

  // La clase va por sessionId o por scheduleId + startsAt (si aún no existe).
  @Get('sessions/roster')
  @RequirePermissions('barber:appointments:read')
  roster(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: BarberClassSessionRefDto,
  ) {
    return this.classes.roster(ctx, query);
  }

  // Solo esta clase: cupo, entrenador o cancelarla.
  @Patch('sessions')
  @RequirePermissions('barber:appointments:write')
  updateSession(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: UpdateBarberClassSessionDto,
  ) {
    return this.classes.updateSession(ctx, dto);
  }

  @Post('sessions/attendees')
  @RequirePermissions('barber:appointments:write')
  addAttendee(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: AddBarberClassAttendeeDto,
  ) {
    return this.classes.addAttendee(ctx, dto);
  }

  // Pasar lista de una vez.
  @Post('sessions/attendance')
  @RequirePermissions('barber:appointments:write')
  markAttendance(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: MarkBarberClassAttendanceDto,
  ) {
    return this.classes.markAttendance(ctx, dto);
  }

  @Patch('attendees/:appointmentId')
  @RequirePermissions('barber:appointments:write')
  setAttendance(
    @CurrentTenant() ctx: TenantContext,
    @Param('appointmentId') appointmentId: string,
    @Body() dto: SetBarberClassAttendeeDto,
  ) {
    return this.classes.setAttendance(ctx, appointmentId, dto.attended);
  }

  @Delete('attendees/:appointmentId')
  @RequirePermissions('barber:appointments:write')
  removeAttendee(
    @CurrentTenant() ctx: TenantContext,
    @Param('appointmentId') appointmentId: string,
  ) {
    return this.classes.removeAttendee(ctx, appointmentId);
  }
}
