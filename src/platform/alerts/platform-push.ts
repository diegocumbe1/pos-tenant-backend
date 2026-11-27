import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { calendarDayCO } from '../../common/date.util';
import { WebPushProvider } from '../../notifications/web-push.provider';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * El cliente pidió activar un negocio bloqueado desde el switch
 * (ActivationRequestService). Se guarda en `platform_alerts`, una por negocio y día.
 */
export const ACTIVATION_REQUEST_ALERT = 'activation.requested';

/**
 * El dueño sumó un servicio (vertical) desde Tu plan. El negocio nace en prueba;
 * la alerta sigue abierta hasta que el super-admin lo active, suspenda o cancele.
 */
export const VERTICAL_ADDED_ALERT = 'vertical.added';

export interface PushResult {
  sent: number;
  failed: number;
  inactive: number;
}

export interface PlatformPushMessage {
  title: string;
  body: string;
  url: string;
  data: Record<string, unknown>;
}

/**
 * Push a los super-admin activos (o solo a `onlyUserId`). Nunca lanza por un
 * dispositivo: los que ya no existen (404/410) se apagan.
 *
 * Es una función y no un servicio para poder usarla fuera de PlatformModule
 * (la solicitud de activación vive en Auth) sin levantar un segundo
 * `PlatformAlertsService`, que arrancaría otro temporizador de avisos.
 */
export async function sendPlatformPush(
  prisma: PrismaService,
  webPush: WebPushProvider,
  logger: Logger,
  message: PlatformPushMessage,
  onlyUserId?: string,
): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, inactive: 0 };
  if (!webPush.isConfigured()) {
    if (onlyUserId) webPush.getPublicKey();
    logger.warn('Avisos de plataforma sin push: faltan las claves VAPID');
    return result;
  }
  const admins = await prisma.user.findMany({
    where: {
      isPlatformAdmin: true,
      isActive: true,
      ...(onlyUserId ? { id: onlyUserId } : {}),
    },
    select: { id: true },
  });
  const devices = await prisma.platformPushSubscription.findMany({
    where: { userId: { in: admins.map((a) => a.id) }, isActive: true },
  });
  for (const device of devices) {
    try {
      await webPush.send(
        { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth },
        message,
      );
      result.sent += 1;
    } catch (error) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        result.inactive += 1;
        await prisma.platformPushSubscription.update({
          where: { id: device.id },
          data: { isActive: false, lastSeenAt: new Date() },
        });
      } else {
        result.failed += 1;
        logger.warn(
          `Push de plataforma falló: ${error instanceof Error ? error.message : 'desconocido'}`,
        );
      }
    }
  }
  return result;
}

/**
 * Guarda una alerta en la consola (una por tipo, negocio y día) y avisa por push.
 * Devuelve false si ya existía hoy: no vuelve a avisar. El push nunca la tumba.
 */
export async function recordPlatformAlert(
  prisma: PrismaService,
  webPush: WebPushProvider,
  logger: Logger,
  input: {
    type: string;
    tenantId: string;
    title: string;
    body: string;
    url: string;
  },
): Promise<{ created: boolean }> {
  const dueDay = calendarDayCO(new Date());
  const key = { type: input.type, tenantId: input.tenantId, dueDay };
  const existing = await prisma.platformAlert.findUnique({
    where: { type_tenantId_dueDay: key },
    select: { id: true },
  });
  if (existing) return { created: false };

  let alertId: string;
  try {
    const row = await prisma.platformAlert.create({
      data: { ...key, title: input.title, body: input.body, url: input.url },
      select: { id: true },
    });
    alertId = row.id;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return { created: false };
    }
    throw error;
  }

  try {
    const result = await sendPlatformPush(prisma, webPush, logger, {
      title: input.title,
      body: input.body,
      url: input.url,
      data: { type: input.type },
    });
    if (result.sent > 0) {
      await prisma.platformAlert.update({
        where: { id: alertId },
        data: { pushedAt: new Date() },
      });
    }
  } catch (error) {
    logger.warn(
      `Push de ${input.type} falló: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { created: true };
}
