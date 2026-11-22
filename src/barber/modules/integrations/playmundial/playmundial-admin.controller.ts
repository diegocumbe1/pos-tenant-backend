import { Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../../auth/guards/jwt-auth.guard';
import { NotTrainerGuard } from '../../../../auth/guards/not-trainer.guard';
import { PasswordSetGuard } from '../../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../../auth/types/tenant-context.interface';
import { PlayMundialLinkService } from './playmundial-link.service';

/**
 * Lo que ve y hace el dueño en Ajustes: crear o rotar el token de Play Mundial
 * y revocarlo. Es la llave de la sede, así que pide permiso de escritura.
 */
@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(
  JwtAuthGuard,
  PasswordSetGuard,
  TenantGuard,
  NotTrainerGuard,
  PermissionsGuard,
)
@Controller('barber/integrations/playmundial')
export class PlayMundialAdminController {
  constructor(private readonly links: PlayMundialLinkService) {}

  @Get('status')
  @RequirePermissions('barber:settings:read')
  status(@CurrentTenant() ctx: TenantContext) {
    return this.links.status(ctx);
  }

  // Crea o rota. El token completo solo viene en esta respuesta.
  @Post('token')
  @RequirePermissions('barber:settings:write')
  issue(@CurrentTenant() ctx: TenantContext) {
    return this.links.issue(ctx);
  }

  @Delete('token')
  @RequirePermissions('barber:settings:write')
  revoke(@CurrentTenant() ctx: TenantContext) {
    return this.links.revoke(ctx);
  }
}
