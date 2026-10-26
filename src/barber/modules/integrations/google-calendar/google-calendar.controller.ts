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
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { CurrentTenant } from '../../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../../auth/types/tenant-context.interface';
import { GoogleCalendarService } from './google-calendar.service';

class ConnectDto {
  // Sin especialista = calendario del negocio (todas las citas de la sede).
  @IsOptional()
  @IsString()
  staffId?: string;
}

class ConnectLinkDto {
  @IsString()
  staffId!: string;
}

class UpdateConnectionDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(1440, { each: true })
  reminderMinutes?: number[];

  @IsOptional()
  @IsBoolean()
  includePhone?: boolean;
}

class BusyQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;
}

@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('barber/integrations/google-calendar')
export class GoogleCalendarController {
  constructor(private readonly calendar: GoogleCalendarService) {}

  @Get()
  @RequirePermissions('barber:settings:read')
  status(@CurrentTenant() ctx: TenantContext) {
    return this.calendar.status(ctx);
  }

  @Post('connect')
  @RequirePermissions('barber:settings:write')
  connect(@CurrentTenant() ctx: TenantContext, @Body() dto: ConnectDto) {
    return this.calendar.connectUrl(ctx, dto.staffId ?? null);
  }

  @Post('connect-link')
  @RequirePermissions('barber:settings:write')
  connectLink(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: ConnectLinkDto,
  ) {
    return this.calendar.connectLink(ctx, dto.staffId);
  }

  @Patch('connections/:id')
  @RequirePermissions('barber:settings:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateConnectionDto,
  ) {
    return this.calendar.updateConnection(ctx, id, dto);
  }

  @Delete('connections/:id')
  @RequirePermissions('barber:settings:write')
  disconnect(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.calendar.disconnect(ctx, id);
  }

  @Post('sync')
  @RequirePermissions('barber:settings:write')
  sync(@CurrentTenant() ctx: TenantContext) {
    return this.calendar.syncNow(ctx);
  }

  // Bloques "Ocupado (Google)" de la agenda.
  @Get('busy')
  @RequirePermissions('barber:appointments:read')
  busy(@CurrentTenant() ctx: TenantContext, @Query() query: BusyQueryDto) {
    return this.calendar.busyForBranch(ctx, query.from, query.to);
  }
}
