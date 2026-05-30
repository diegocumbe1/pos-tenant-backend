import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { BarberSettingsService } from './barber-settings.service';
import { UpdateBarberSettingsDto } from './dto/barber-settings.dto';

@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('barber/settings')
export class BarberSettingsController {
  constructor(private readonly settingsService: BarberSettingsService) {}

  @Get()
  @RequirePermissions('barber:settings:read')
  getSettings(@CurrentTenant() ctx: TenantContext) {
    return this.settingsService.getSettings(ctx);
  }

  @Patch()
  @RequirePermissions('barber:settings:write')
  updateSettings(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: UpdateBarberSettingsDto,
  ) {
    return this.settingsService.updateSettings(ctx, dto);
  }
}
