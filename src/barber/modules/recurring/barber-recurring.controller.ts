import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { BarberRecurringService } from './barber-recurring.service';
import {
  CreateBarberRecurringBookingDto,
  EndBarberRecurringBookingDto,
} from './dto/barber-recurring.dto';

// Reservas fijas semanales (canchas). Son agenda: mismos permisos.
@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('barber/recurring-bookings')
export class BarberRecurringController {
  constructor(private readonly recurring: BarberRecurringService) {}

  @Get()
  @RequirePermissions('barber:appointments:read')
  list(@CurrentTenant() ctx: TenantContext) {
    return this.recurring.list(ctx);
  }

  @Post()
  @RequirePermissions('barber:appointments:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateBarberRecurringBookingDto,
  ) {
    return this.recurring.create(ctx, dto);
  }

  @Post(':id/end')
  @RequirePermissions('barber:appointments:write')
  end(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: EndBarberRecurringBookingDto,
  ) {
    return this.recurring.end(ctx, id, dto);
  }
}
