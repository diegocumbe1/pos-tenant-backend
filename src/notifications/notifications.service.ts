import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationChannel,
  NotificationStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../auth/types/tenant-context.interface';
import {
  CreateNotificationEventDto,
  ListNotificationsQueryDto,
  UpsertNotificationPreferenceDto,
  UpsertWebPushSubscriptionDto,
} from './dto/notification.dto';
import { WebPushProvider } from './web-push.provider';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webPush: WebPushProvider,
  ) {}

  async listEvents(ctx: TenantContext, query: ListNotificationsQueryDto) {
    const limit = query.limit ?? 50;
    const where: Prisma.NotificationEventWhereInput = {
      tenantId: ctx.tenantId,
      AND: [
        { OR: [{ branchId: ctx.branchId }, { branchId: null }] },
        { OR: [{ userId: ctx.userId }, { userId: null }] },
      ],
      ...(query.type ? { type: query.type } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.unreadOnly ? { readAt: null } : {}),
    };

    const [events, unreadCount] = await Promise.all([
      this.prisma.notificationEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.notificationEvent.count({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          userId: ctx.userId,
          readAt: null,
        },
      }),
    ]);

    return {
      events: events.map((event) => this.mapEvent(event)),
      unreadCount,
    };
  }

  async createEvent(ctx: TenantContext, dto: CreateNotificationEventDto) {
    await this.assertBranch(ctx, dto.branchId ?? ctx.branchId);
    if (dto.userId) {
      if (
        dto.userId !== ctx.userId &&
        !ctx.isRoot &&
        !ctx.permissions.has('admin:users:invite')
      ) {
        throw new ForbiddenException(
          'Cannot create notifications for another user',
        );
      }
      await this.assertUser(ctx, dto.userId);
    }

    const event = await this.prisma.notificationEvent.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: dto.branchId ?? ctx.branchId,
        userId: dto.userId ?? ctx.userId,
        vertical: dto.vertical,
        type: dto.type,
        channel: dto.channel ?? NotificationChannel.IN_APP,
        status:
          (dto.channel ?? NotificationChannel.IN_APP) === NotificationChannel.IN_APP
            ? NotificationStatus.DELIVERED
            : NotificationStatus.PENDING,
        title: dto.title,
        body: dto.body,
        recipient: this.toJson(dto.recipient),
        payload: this.toJson(dto.payload ?? {}),
        deliveredAt:
          (dto.channel ?? NotificationChannel.IN_APP) === NotificationChannel.IN_APP
            ? new Date()
            : null,
      },
    });
    return this.mapEvent(event);
  }

  async markRead(ctx: TenantContext, id: string) {
    const event = await this.prisma.notificationEvent.findFirst({
      where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
    });
    if (!event) throw new NotFoundException(`Notification ${id} not found`);

    const readAt = event.readAt ?? new Date();
    const updated = await this.prisma.notificationEvent.update({
      where: { id },
      data: {
        readAt,
        status:
          event.channel === NotificationChannel.IN_APP
            ? NotificationStatus.READ
            : event.status,
      },
    });
    return this.mapEvent(updated);
  }

  async markAllRead(ctx: TenantContext) {
    const readAt = new Date();
    const result = await this.prisma.notificationEvent.updateMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        userId: ctx.userId,
        readAt: null,
      },
      data: { readAt, status: NotificationStatus.READ },
    });
    return { updated: result.count, readAt: readAt.toISOString() };
  }

  async listPreferences(ctx: TenantContext) {
    const preferences = await this.prisma.notificationPreference.findMany({
      where: { tenantId: ctx.tenantId, userId: ctx.userId },
      orderBy: [{ vertical: 'asc' }, { type: 'asc' }],
    });
    return { preferences: preferences.map((p) => this.mapPreference(p)) };
  }

  async upsertPreference(
    ctx: TenantContext,
    dto: UpsertNotificationPreferenceDto,
  ) {
    const existing = await this.prisma.notificationPreference.findFirst({
      where: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        vertical: dto.vertical ?? 'shared',
        type: dto.type,
      },
    });
    const data = {
      vertical: dto.vertical ?? 'shared',
      type: dto.type,
      inApp: dto.inApp ?? true,
      webPush: dto.webPush ?? false,
      email: dto.email ?? false,
      whatsapp: dto.whatsapp ?? false,
      quietStart: dto.quietStart ?? null,
      quietEnd: dto.quietEnd ?? null,
      timezone: dto.timezone ?? 'America/Bogota',
      enabled: dto.enabled ?? true,
    };

    const preference = existing
      ? await this.prisma.notificationPreference.update({
          where: { id: existing.id },
          data,
        })
      : await this.prisma.notificationPreference.create({
          data: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            ...data,
          },
        });

    return this.mapPreference(preference);
  }

  async listWebPushSubscriptions(ctx: TenantContext) {
    const subscriptions = await this.prisma.webPushSubscription.findMany({
      where: { tenantId: ctx.tenantId, userId: ctx.userId, isActive: true },
      orderBy: { lastSeenAt: 'desc' },
    });
    return { subscriptions: subscriptions.map((s) => this.mapSubscription(s)) };
  }

  getWebPushPublicKey() {
    return { publicKey: this.webPush.getPublicKey() };
  }

  async upsertWebPushSubscription(
    ctx: TenantContext,
    dto: UpsertWebPushSubscriptionDto,
  ) {
    const now = new Date();
    const existing = await this.prisma.webPushSubscription.findUnique({
      where: { endpoint: dto.endpoint },
    });

    if (existing && existing.tenantId !== ctx.tenantId) {
      throw new ForbiddenException('Subscription endpoint belongs to another tenant');
    }

    const subscription = existing
      ? await this.prisma.webPushSubscription.update({
          where: { id: existing.id },
          data: {
            branchId: ctx.branchId,
            userId: ctx.userId,
            p256dh: dto.keys.p256dh,
            auth: dto.keys.auth,
            expirationTime: dto.expirationTime
              ? new Date(dto.expirationTime)
              : null,
            userAgent: dto.userAgent,
            deviceLabel: dto.deviceLabel,
            isActive: true,
            lastSeenAt: now,
          },
        })
      : await this.prisma.webPushSubscription.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            userId: ctx.userId,
            endpoint: dto.endpoint,
            p256dh: dto.keys.p256dh,
            auth: dto.keys.auth,
            expirationTime: dto.expirationTime
              ? new Date(dto.expirationTime)
              : null,
            userAgent: dto.userAgent,
            deviceLabel: dto.deviceLabel,
            lastSeenAt: now,
          },
        });

    return this.mapSubscription(subscription);
  }

  async deactivateWebPushSubscription(ctx: TenantContext, id: string) {
    const existing = await this.prisma.webPushSubscription.findFirst({
      where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
    });
    if (!existing) throw new NotFoundException(`Subscription ${id} not found`);

    const updated = await this.prisma.webPushSubscription.update({
      where: { id },
      data: { isActive: false, lastSeenAt: new Date() },
    });
    return this.mapSubscription(updated);
  }

  async sendWebPushTest(ctx: TenantContext) {
    const event = await this.prisma.notificationEvent.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        userId: ctx.userId,
        type: 'web_push.test',
        channel: NotificationChannel.WEB_PUSH,
        status: NotificationStatus.PENDING,
        title: 'Lynko test',
        body: 'Tus notificaciones Web Push están conectadas.',
        payload: {
          url: '/app',
          kind: 'web_push_test',
        },
      },
    });

    const subscriptions = await this.prisma.webPushSubscription.findMany({
      where: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        isActive: true,
      },
    });

    if (subscriptions.length === 0) {
      const failed = await this.prisma.notificationEvent.update({
        where: { id: event.id },
        data: {
          status: NotificationStatus.FAILED,
          failedAt: new Date(),
          failureReason: 'NO_ACTIVE_WEB_PUSH_SUBSCRIPTIONS',
        },
      });
      return {
        event: this.mapEvent(failed),
        sent: 0,
        failed: 0,
        inactive: 0,
      };
    }

    let sent = 0;
    let failed = 0;
    let inactive = 0;
    const errors: string[] = [];

    for (const subscription of subscriptions) {
      try {
        await this.webPush.send(
          {
            endpoint: subscription.endpoint,
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
          {
            title: event.title,
            body: event.body ?? undefined,
            url: '/app',
            data: {
              notificationId: event.id,
              type: event.type,
            },
          },
        );
        sent += 1;
      } catch (error) {
        failed += 1;
        const statusCode = this.webPushStatusCode(error);
        const message =
          error instanceof Error ? error.message : 'Unknown Web Push error';
        errors.push(statusCode ? `${statusCode}: ${message}` : message);

        if (statusCode === 404 || statusCode === 410) {
          inactive += 1;
          await this.prisma.webPushSubscription.update({
            where: { id: subscription.id },
            data: { isActive: false, lastSeenAt: new Date() },
          });
        }
      }
    }

    const now = new Date();
    const updated = await this.prisma.notificationEvent.update({
      where: { id: event.id },
      data:
        sent > 0
          ? {
              status: NotificationStatus.SENT,
              deliveredAt: now,
              failureReason: errors.length > 0 ? errors.join(' | ') : null,
            }
          : {
              status: NotificationStatus.FAILED,
              failedAt: now,
              failureReason: errors.join(' | ') || 'WEB_PUSH_SEND_FAILED',
            },
    });

    return {
      event: this.mapEvent(updated),
      sent,
      failed,
      inactive,
    };
  }

  private async assertBranch(ctx: TenantContext, branchId: string) {
    if (
      branchId !== ctx.branchId &&
      !ctx.isRoot &&
      !ctx.accessibleBranches.includes(branchId)
    ) {
      throw new ForbiddenException(`Branch ${branchId} is not accessible`);
    }

    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException(`Branch ${branchId} not found`);
  }

  private async assertUser(ctx: TenantContext, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId: ctx.tenantId, isActive: true },
      select: { id: true },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found`);
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return (value ?? {}) as Prisma.InputJsonValue;
  }

  private webPushStatusCode(error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ) {
      return (error as { statusCode: number }).statusCode;
    }
    return undefined;
  }

  private mapEvent(event: any) {
    return {
      id: event.id,
      tenantId: event.tenantId,
      branchId: event.branchId ?? undefined,
      userId: event.userId ?? undefined,
      vertical: event.vertical ?? undefined,
      type: event.type,
      channel: event.channel,
      status: event.status,
      title: event.title,
      body: event.body ?? undefined,
      recipient: event.recipient ?? undefined,
      payload: event.payload ?? {},
      readAt: event.readAt?.toISOString() ?? undefined,
      deliveredAt: event.deliveredAt?.toISOString() ?? undefined,
      failedAt: event.failedAt?.toISOString() ?? undefined,
      failureReason: event.failureReason ?? undefined,
      createdAt: event.createdAt.toISOString(),
      updatedAt: event.updatedAt.toISOString(),
    };
  }

  private mapPreference(preference: any) {
    return {
      id: preference.id,
      type: preference.type,
      vertical: preference.vertical ?? undefined,
      channels: {
        inApp: preference.inApp,
        webPush: preference.webPush,
        email: preference.email,
        whatsapp: preference.whatsapp,
      },
      quietHours:
        preference.quietStart || preference.quietEnd
          ? {
              start: preference.quietStart ?? undefined,
              end: preference.quietEnd ?? undefined,
              timezone: preference.timezone,
            }
          : undefined,
      enabled: preference.enabled,
      updatedAt: preference.updatedAt.toISOString(),
    };
  }

  private mapSubscription(subscription: any) {
    return {
      id: subscription.id,
      branchId: subscription.branchId ?? undefined,
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime?.toISOString() ?? undefined,
      userAgent: subscription.userAgent ?? undefined,
      deviceLabel: subscription.deviceLabel ?? undefined,
      isActive: subscription.isActive,
      lastSeenAt: subscription.lastSeenAt.toISOString(),
      createdAt: subscription.createdAt.toISOString(),
      updatedAt: subscription.updatedAt.toISOString(),
    };
  }
}
