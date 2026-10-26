import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlatformActor } from '../../platform/decorators/platform-actor.decorator';
import { PlatformAdminGuard } from '../../platform/guards/platform-admin.guard';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { AuthService } from '../services/auth.service';
import { AuthenticatedUser } from '../types/tenant-context.interface';
import {
  ListSupportSessionsQueryDto,
  StartSupportSessionDto,
} from './support-session.dto';
import { SupportSessionService } from './support-session.service';

/**
 * Modo soporte: el super-admin entra a un negocio sin pedir contraseñas.
 * Vive en AuthModule (y no en PlatformModule) porque TenantGuard y /auth/me
 * dependen de él, y PlatformModule → Alexa → Assistant → Auth cerraría un ciclo.
 */
@ApiTags('Platform · Support')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform/support-sessions')
export class SupportSessionController {
  constructor(
    private readonly auth: AuthService,
    private readonly supportSessions: SupportSessionService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Open a support session on a tenant. Returns the tenant-scoped profile.',
  })
  start(
    @PlatformActor() actor: AuthenticatedUser,
    @Body() dto: StartSupportSessionDto,
  ) {
    return this.auth.startSupportSession(actor, {
      tenantId: dto.tenantId,
      reason: dto.reason,
      durationMinutes: dto.durationMinutes ?? 60,
    });
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End a support session' })
  end(@Param('id') id: string) {
    return this.supportSessions.end(id);
  }

  @Get()
  @ApiOperation({ summary: 'Support session history (25 per page)' })
  list(@Query() query: ListSupportSessionsQueryDto) {
    return this.supportSessions.list(query);
  }

  @Get(':id/actions')
  @ApiOperation({ summary: 'Writes made during a support session' })
  actions(@Param('id') id: string) {
    return this.supportSessions.listActions(id);
  }
}
