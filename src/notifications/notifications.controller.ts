import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../auth/guards/password-set.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { TenantContext } from '../auth/types/tenant-context.interface';
import {
  CreateNotificationEventDto,
  ListNotificationsQueryDto,
  UpsertNotificationPreferenceDto,
  UpsertWebPushSubscriptionDto,
} from './dto/notification.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('events')
  listEvents(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.notifications.listEvents(ctx, query);
  }

  @Post('events')
  @HttpCode(HttpStatus.CREATED)
  createEvent(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateNotificationEventDto,
  ) {
    return this.notifications.createEvent(ctx, dto);
  }

  @Patch('events/:id/read')
  markRead(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.notifications.markRead(ctx, id);
  }

  @Post('events/read-all')
  markAllRead(@CurrentTenant() ctx: TenantContext) {
    return this.notifications.markAllRead(ctx);
  }

  @Get('preferences')
  listPreferences(@CurrentTenant() ctx: TenantContext) {
    return this.notifications.listPreferences(ctx);
  }

  @Post('preferences')
  @HttpCode(HttpStatus.OK)
  upsertPreference(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: UpsertNotificationPreferenceDto,
  ) {
    return this.notifications.upsertPreference(ctx, dto);
  }

  @Get('web-push/subscriptions')
  listWebPushSubscriptions(@CurrentTenant() ctx: TenantContext) {
    return this.notifications.listWebPushSubscriptions(ctx);
  }

  @Post('web-push/subscriptions')
  @HttpCode(HttpStatus.OK)
  upsertWebPushSubscription(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: UpsertWebPushSubscriptionDto,
  ) {
    return this.notifications.upsertWebPushSubscription(ctx, dto);
  }

  @Delete('web-push/subscriptions/:id')
  deactivateWebPushSubscription(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    return this.notifications.deactivateWebPushSubscription(ctx, id);
  }
}
