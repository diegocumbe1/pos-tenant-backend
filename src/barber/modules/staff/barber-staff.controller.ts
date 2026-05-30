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
import { BarberStaffService } from './barber-staff.service';
import {
  CreateBarberStaffDto,
  UpdateBarberStaffDto,
} from './dto/barber-staff.dto';

@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('barber/staff')
export class BarberStaffController {
  constructor(private readonly staffService: BarberStaffService) {}

  @Get()
  @RequirePermissions('barber:staff:read')
  list(@CurrentTenant() ctx: TenantContext) {
    return this.staffService.listStaff(ctx);
  }

  @Post()
  @RequirePermissions('barber:staff:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateBarberStaffDto,
  ) {
    return this.staffService.createStaff(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('barber:staff:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateBarberStaffDto,
  ) {
    return this.staffService.updateStaff(ctx, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('barber:staff:write')
  remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.staffService.deleteStaff(ctx, id);
  }
}
