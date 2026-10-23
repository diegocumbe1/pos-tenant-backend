import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CurrentTenant } from '../../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../../auth/types/tenant-context.interface';
import { InMoveSyncService } from './inmove-sync.service';

class InMoveSyncDto {
  // true = solo muestra lo que haría, sin escribir.
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('barber/integrations/inmove')
export class InMoveSyncController {
  constructor(private readonly inmove: InMoveSyncService) {}

  // Si el botón aparece: solo para los negocios habilitados.
  @Get('status')
  @RequirePermissions('barber:customers:read')
  status(@CurrentTenant() ctx: TenantContext) {
    return this.inmove.status(ctx);
  }

  @Post('sync')
  @RequirePermissions('barber:customers:write')
  sync(@CurrentTenant() ctx: TenantContext, @Body() dto: InMoveSyncDto) {
    return this.inmove.sync(ctx, dto.dryRun ?? false);
  }
}
