import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import { UpsertWebPushSubscriptionDto } from '../../notifications/dto/notification.dto';
import { PlatformActor } from '../decorators/platform-actor.decorator';
import { PlatformAdminGuard } from '../guards/platform-admin.guard';
import { PlatformAlertsService } from './platform-alerts.service';

class RemoveDeviceDto {
  @IsString()
  endpoint!: string;
}

/** Avisos del super-admin. Sin X-Tenant-Id: no ocurren dentro de ningún negocio. */
@ApiTags('Platform')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform/alerts')
export class PlatformAlertsController {
  constructor(private readonly alerts: PlatformAlertsService) {}

  @Get()
  list() {
    return this.alerts.list();
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead() {
    return this.alerts.markAllRead();
  }

  @Post('check-now')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revisa los vencimientos ahora, sin esperar el reloj',
  })
  checkNow() {
    return this.alerts.run();
  }

  @Get('push/public-key')
  publicKey() {
    return this.alerts.getPublicKey();
  }

  @Post('push/subscriptions')
  @HttpCode(HttpStatus.OK)
  saveDevice(
    @PlatformActor() actor: AuthenticatedUser,
    @Body() dto: UpsertWebPushSubscriptionDto,
  ) {
    return this.alerts.saveDevice(actor.id, dto);
  }

  @Post('push/unsubscribe')
  @HttpCode(HttpStatus.OK)
  removeDevice(
    @PlatformActor() actor: AuthenticatedUser,
    @Body() dto: RemoveDeviceDto,
  ) {
    return this.alerts.removeDevice(actor.id, dto.endpoint);
  }

  @Post('push/test')
  @HttpCode(HttpStatus.OK)
  sendTest(@PlatformActor() actor: AuthenticatedUser) {
    return this.alerts.sendTest(actor.id);
  }
}
