import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, NotificationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WebPushProvider } from './web-push.provider';
import { rolesForEvent } from './notification-events.config';
import {
  catalogForType,
  ruleFor,
  wantsNotification,
  type NotificationContext,
} from './notification-rules';

export interface DispatchParams {
  tenantId: string;
  branchId?: string | null;
  vertical?: string;
  /** Tipo de evento, debe existir en NOTIFICATION_EVENT_ROLES. */
  type: string;
  title: string;
  body?: string;
  /** Ruta destino al hacer click en la notificación. */
  url?: string;
  payload?: Record<string, unknown>;
  /** No notificar a este usuario (p. ej. quien disparó la acción). */
  excludeUserId?: string;
  /** De qué trata, para los filtros de cada persona (solo avisos de agenda). */
  context?: NotificationContext;
}

@Injectable()
export class NotificationDispatcherService {
  private readonly logger = new Logger(NotificationDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webPush: WebPushProvider,
  ) {}

  /**
   * Dispatch best-effort: NUNCA lanza. Una notificación fallida no debe
   * romper la operación del POS/cocina que la disparó.
   */
  async dispatch(params: DispatchParams): Promise<void> {
    try {
      await this.dispatchInternal(params);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown dispatch error';
      this.logger.error(`dispatch(${params.type}) failed: ${message}`);
    }
  }

  private async dispatchInternal(params: DispatchParams): Promise<void> {
    const roles = rolesForEvent(params.type);
    if (roles.length === 0) {
      this.logger.warn(`No roles mapped for event "${params.type}"`);
      return;
    }

    if (catalogForType(params.type)) {
      await this.deliver(params, await this.recipientsFor(params));
      return;
    }

    // 1. Destinatarios: usuarios activos del tenant (y sede si aplica) cuyo
    //    rol está en la lista del evento, excluyendo al que disparó la acción.
    const users = await this.prisma.user.findMany({
      where: {
        tenantId: params.tenantId,
        isActive: true,
        role: { code: { in: roles } },
        ...(params.branchId
          ? { userBranches: { some: { branchId: params.branchId } } }
          : {}),
        ...(params.excludeUserId ? { id: { not: params.excludeUserId } } : {}),
      },
      select: { id: true },
    });

    if (users.length === 0) return;

    await this.deliver(
      params,
      users.map((user) => user.id),
    );
  }

  /**
   * Para quien ya resolvió los destinatarios (los recordatorios de agenda deciden
   * por regla y no por el mapa evento → roles). Best-effort, igual que `dispatch`.
   */
  async dispatchToUsers(params: DispatchParams, userIds: string[]) {
    if (userIds.length === 0) return;
    try {
      await this.deliver(params, userIds);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown dispatch error';
      this.logger.error(`dispatchToUsers(${params.type}) failed: ${message}`);
    }
  }

  /**
   * Decide lo que cada quien eligió, no solo el mapa de roles, y solo entra quien
   * hoy tiene el permiso de esa pantalla: el aviso lleva a ella.
   */
  async recipientsFor(
    params: Pick<
      DispatchParams,
      'tenantId' | 'branchId' | 'type' | 'context' | 'excludeUserId'
    >,
  ): Promise<string[]> {
    const catalog = catalogForType(params.type);
    if (!catalog) return [];
    const roles = rolesForEvent(params.type);
    const [users, rules, staffUser] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          tenantId: params.tenantId,
          isActive: true,
          role: {
            rolePermissions: {
              some: { permission: { code: catalog.permission } },
            },
          },
          ...(params.branchId
            ? {
                OR: [
                  { role: { code: 'OWNER' } },
                  { userBranches: { some: { branchId: params.branchId } } },
                ],
              }
            : {}),
          ...(params.excludeUserId
            ? { id: { not: params.excludeUserId } }
            : {}),
        },
        select: { id: true, role: { select: { code: true } } },
      }),
      this.prisma.appointmentReminderRule.findMany({
        where: { tenantId: params.tenantId },
      }),
      params.context?.staffUserId
        ? this.prisma.user.findUnique({
            where: { id: params.context.staffUserId },
            select: { role: { select: { code: true } } },
          })
        : null,
    ]);
    const context = params.context
      ? { ...params.context, staffRoleCode: staffUser?.role.code ?? null }
      : null;
    return users
      .filter((user) => {
        const subject = { id: user.id, roleCode: user.role.code };
        return wantsNotification(
          subject,
          ruleFor(subject, rules),
          params.type,
          context,
          roles.includes(user.role.code),
        );
      })
      .map((user) => user.id);
  }

  private async deliver(params: DispatchParams, allUserIds: string[]) {
    // Quien pausó no recibe nada, de ningún tipo.
    const paused = await this.prisma.notificationPause.findMany({
      where: { userId: { in: allUserIds }, pausedUntil: { gt: new Date() } },
      select: { userId: true },
    });
    const pausedIds = new Set(paused.map((p) => p.userId));
    const userIds = allUserIds.filter((id) => !pausedIds.has(id));
    if (userIds.length === 0) return;
    const users = userIds.map((id) => ({ id }));
    const [preferences, subscriptions] = await Promise.all([
      this.prisma.notificationPreference.findMany({
        where: {
          tenantId: params.tenantId,
          userId: { in: userIds },
          type: params.type,
        },
      }),
      this.prisma.webPushSubscription.findMany({
        where: {
          tenantId: params.tenantId,
          userId: { in: userIds },
          isActive: true,
        },
      }),
    ]);
    const preferenceByUser = new Map(
      preferences.map((preference) => [preference.userId, preference]),
    );
    const subscriptionsByUser = new Map<string, typeof subscriptions>();
    for (const subscription of subscriptions) {
      const list = subscriptionsByUser.get(subscription.userId) ?? [];
      list.push(subscription);
      subscriptionsByUser.set(subscription.userId, list);
    }

    for (const user of users) {
      // 2. Preferencia efectiva por usuario. Sin fila => default = recibir
      //    (web push ON para roles objetivo). El usuario puede optar por no.
      const pref = preferenceByUser.get(user.id);
      const wantsWebPush = pref ? pref.enabled && pref.webPush : true;
      if (!wantsWebPush) continue;
      if (
        pref &&
        this.isQuietNow(pref.quietStart, pref.quietEnd, pref.timezone)
      ) {
        continue;
      }

      // 3. Suscripciones web push activas del usuario.
      const userSubscriptions = subscriptionsByUser.get(user.id) ?? [];
      if (userSubscriptions.length === 0) continue;

      // 4. Un NotificationEvent por destinatario (registro + tracking).
      const event = await this.prisma.notificationEvent.create({
        data: {
          tenantId: params.tenantId,
          branchId: params.branchId ?? null,
          userId: user.id,
          vertical: params.vertical ?? null,
          type: params.type,
          channel: NotificationChannel.WEB_PUSH,
          status: NotificationStatus.PENDING,
          title: params.title,
          body: params.body ?? null,
          payload: {
            url: params.url ?? '/app',
            ...(params.payload ?? {}),
          },
        },
      });

      let sent = 0;
      const errors: string[] = [];
      for (const subscription of userSubscriptions) {
        try {
          await this.webPush.send(
            {
              endpoint: subscription.endpoint,
              p256dh: subscription.p256dh,
              auth: subscription.auth,
            },
            {
              title: params.title,
              body: params.body,
              url: params.url ?? '/app',
              data: { notificationId: event.id, type: params.type },
            },
          );
          sent += 1;
        } catch (error) {
          const statusCode = this.webPushStatusCode(error);
          errors.push(
            error instanceof Error ? error.message : 'Unknown Web Push error',
          );
          if (statusCode === 404 || statusCode === 410) {
            await this.prisma.webPushSubscription.update({
              where: { id: subscription.id },
              data: { isActive: false, lastSeenAt: new Date() },
            });
          }
        }
      }

      const now = new Date();
      await this.prisma.notificationEvent.update({
        where: { id: event.id },
        data:
          sent > 0
            ? { status: NotificationStatus.SENT, deliveredAt: now }
            : {
                status: NotificationStatus.FAILED,
                failedAt: now,
                failureReason: errors.join(' | ') || 'WEB_PUSH_SEND_FAILED',
              },
      });
    }
  }

  // Quiet hours simple: HH:mm en la zona del usuario. Soporta rango que cruza
  // medianoche (p. ej. 22:00 -> 07:00).
  private isQuietNow(
    quietStart: string | null,
    quietEnd: string | null,
    timezone: string,
  ): boolean {
    if (!quietStart || !quietEnd) return false;
    try {
      const now = new Date();
      const hhmm = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: timezone || 'America/Bogota',
      }).format(now);
      if (quietStart <= quietEnd) {
        return hhmm >= quietStart && hhmm < quietEnd;
      }
      // Cruza medianoche.
      return hhmm >= quietStart || hhmm < quietEnd;
    } catch {
      return false;
    }
  }

  private webPushStatusCode(error: unknown): number | undefined {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const code = (error as { statusCode?: unknown }).statusCode;
      return typeof code === 'number' ? code : undefined;
    }
    return undefined;
  }
}
