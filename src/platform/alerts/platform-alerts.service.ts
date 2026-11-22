import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { calendarDayCO, clockTimeCO } from '../../common/date.util';
import { UpsertWebPushSubscriptionDto } from '../../notifications/dto/notification.dto';
import { WebPushProvider } from '../../notifications/web-push.provider';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BillingAlertType,
  billingAlertFor,
  billingAlertText,
  billingDatesOf,
  billingGroupText,
  PendingInstallment,
} from './billing-alert-rules';

const TICK_MS = 15 * 60_000;
/** Un aviso de cobro a las 3 a. m. no le sirve a nadie. */
const FIRST_HOUR = 8;
const LAST_HOUR = 20;
const OPEN_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE'] as const;
const ALERTS_PAGE = '/admin/alerts';

export interface PushResult {
  sent: number;
  failed: number;
  inactive: number;
}

const tenantUrl = (tenantId: string) => `/admin/tenants/${tenantId}`;

/**
 * Le avisa al super-admin de lo que hay que cobrar: 2 días antes, el día del
 * vencimiento y al terminar la gracia.
 *
 * SOLO AVISA. No le escribe al cliente ni suspende cuentas: esa decisión sigue
 * siendo de una persona, desde la ficha de la cuenta. Sigue el patrón de
 * `PaymentAlertsService`: `setInterval` y una fila que se reclama antes de enviar,
 * así que repetir es imposible y perder uno es posible.
 */
@Injectable()
export class PlatformAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlatformAlertsService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly webPush: WebPushProvider,
  ) {}

  onModuleInit() {
    if (process.env.PLATFORM_BILLING_ALERTS_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Nunca lanza. */
  async tick(now = new Date()) {
    if (this.running) return;
    const hour = Number(clockTimeCO(now).slice(0, 2));
    if (hour < FIRST_HOUR || hour >= LAST_HOUR) return;
    this.running = true;
    try {
      await this.run(now);
    } catch (error) {
      this.logger.error(
        `Avisos de cobro: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Revisa todas las cuentas y avisa lo nuevo. Devuelve cuántos avisos creó. */
  async run(now = new Date()): Promise<{ created: number }> {
    const today = calendarDayCO(now);
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        status: { in: [...OPEN_STATUSES] },
        tenant: { status: 'ACTIVE', deletedAt: null },
      },
      select: {
        tenantId: true,
        status: true,
        trialEndsAt: true,
        nextPaymentDueAt: true,
        currentPeriodEnd: true,
        graceEndsAt: true,
        tenant: {
          select: {
            name: true,
            billingGroup: {
              select: { isActive: true, name: true, primaryTenantId: true },
            },
          },
        },
      },
    });

    // Planes en cuotas con saldo: el último pago real de la cuenta manda. Una
    // sola consulta para todas, no una por cuenta.
    const pending = await this.pendingInstallments(
      subscriptions.map((sub) => sub.tenantId),
    );

    const created: {
      id: string;
      type: BillingAlertType;
      tenantId: string;
      name: string;
      title: string;
      body: string;
    }[] = [];
    for (const sub of subscriptions) {
      // Un combo se cobra junto: avisa solo el negocio principal, con el nombre
      // del combo. Los demás quedan alineados a su vencimiento.
      const group = sub.tenant.billingGroup?.isActive
        ? sub.tenant.billingGroup
        : null;
      if (group && group.primaryTenantId !== sub.tenantId) continue;
      const dates = billingDatesOf(sub);
      const type = billingAlertFor(today, dates);
      if (!type) continue;
      const name = (group?.name ?? sub.tenant.name).trim();
      const text = billingAlertText(
        type,
        name,
        today,
        dates.dueDay,
        pending.get(sub.tenantId) ?? null,
      );
      // Casi todos los ciclos repiten un aviso que ya se dio. Preguntar primero evita
      // provocar la violación de la llave única: Prisma imprime `prisma:error` por cada
      // una aunque se capture, y llenaba la consola de ruido en cada ciclo.
      const alreadySent = await this.prisma.platformAlert.findUnique({
        where: {
          type_tenantId_dueDay: {
            type,
            tenantId: sub.tenantId,
            dueDay: dates.dueDay,
          },
        },
        select: { id: true },
      });
      if (alreadySent) continue;
      try {
        const row = await this.prisma.platformAlert.create({
          data: {
            type,
            tenantId: sub.tenantId,
            dueDay: dates.dueDay,
            url: tenantUrl(sub.tenantId),
            ...text,
          },
        });
        created.push({
          id: row.id,
          type,
          tenantId: sub.tenantId,
          name,
          ...text,
        });
      } catch (error) {
        // Respaldo: otro proceso avisó justo entre la consulta y el create. Con una sola
        // instancia no pasa, pero la llave única sigue siendo la garantía real.
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2002'
        ) {
          throw error;
        }
      }
    }

    const groups = new Map<BillingAlertType, typeof created>();
    for (const row of created) {
      groups.set(row.type, [...(groups.get(row.type) ?? []), row]);
    }
    for (const [type, rows] of groups) {
      const text =
        rows.length === 1
          ? { title: rows[0].title, body: rows[0].body }
          : billingGroupText(
              type,
              rows.map((row) => row.name),
            );
      const url = rows.length === 1 ? tenantUrl(rows[0].tenantId) : ALERTS_PAGE;
      const result = await this.sendPush({ ...text, url, data: { type } });
      if (result.sent > 0) {
        await this.prisma.platformAlert.updateMany({
          where: { id: { in: rows.map((row) => row.id) } },
          data: { pushedAt: new Date() },
        });
      }
    }
    return { created: created.length };
  }

  /**
   * Por cuenta, la próxima cuota por cobrar si su último pago real dejó saldo.
   * Si después hubo otro pago (sin cuotas o de otro plan) ya no hay cuota
   * pendiente que recordar.
   */
  private async pendingInstallments(
    tenantIds: string[],
  ): Promise<Map<string, PendingInstallment>> {
    const result = new Map<string, PendingInstallment>();
    if (tenantIds.length === 0) return result;
    const payments = await this.prisma.subscriptionPayment.findMany({
      where: { tenantId: { in: tenantIds }, kind: 'payment' },
      orderBy: { paidAt: 'desc' },
      select: {
        tenantId: true,
        installmentNo: true,
        installmentsTotal: true,
        balanceAfter: true,
        nextDueAmount: true,
      },
    });
    const seen = new Set<string>();
    for (const p of payments) {
      if (seen.has(p.tenantId)) continue;
      seen.add(p.tenantId);
      if (p.installmentNo && p.installmentsTotal && (p.balanceAfter ?? 0) > 0) {
        result.set(p.tenantId, {
          number: p.installmentNo + 1,
          total: p.installmentsTotal,
          amount: p.nextDueAmount,
          balance: p.balanceAfter ?? 0,
        });
      }
    }
    return result;
  }

  // ─── Consola ──────────────────────────────────────────────────────────────

  async list() {
    const alerts = await this.prisma.platformAlert.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const subscriptions = await this.prisma.subscription.findMany({
      where: { tenantId: { in: [...new Set(alerts.map((a) => a.tenantId))] } },
      select: {
        tenantId: true,
        status: true,
        trialEndsAt: true,
        nextPaymentDueAt: true,
        currentPeriodEnd: true,
        graceEndsAt: true,
      },
    });
    const currentDue = new Map(
      subscriptions.map((sub) => [
        sub.tenantId,
        (OPEN_STATUSES as readonly string[]).includes(sub.status)
          ? billingDatesOf(sub).dueDay
          : null,
      ]),
    );
    const unread = await this.prisma.platformAlert.count({
      where: { readAt: null },
    });
    return {
      unread,
      alerts: alerts.map((alert) => ({
        id: alert.id,
        type: alert.type,
        tenantId: alert.tenantId,
        dueDay: alert.dueDay,
        title: alert.title,
        body: alert.body,
        url: alert.url,
        read: !!alert.readAt,
        createdAt: alert.createdAt.toISOString(),
        // Si el vencimiento ya no es ese, pagó o se suspendió: ya no hay nada que hacer.
        open: currentDue.get(alert.tenantId) === alert.dueDay,
      })),
    };
  }

  async markAllRead() {
    const { count } = await this.prisma.platformAlert.updateMany({
      where: { readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }

  // ─── Dispositivos ─────────────────────────────────────────────────────────

  getPublicKey() {
    return { publicKey: this.webPush.getPublicKey() };
  }

  async saveDevice(userId: string, dto: UpsertWebPushSubscriptionDto) {
    const data = {
      userId,
      p256dh: dto.keys.p256dh,
      auth: dto.keys.auth,
      userAgent: dto.userAgent ?? null,
      deviceLabel: dto.deviceLabel ?? null,
      isActive: true,
      lastSeenAt: new Date(),
    };
    const device = await this.prisma.platformPushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: { endpoint: dto.endpoint, ...data },
      update: data,
    });
    return { id: device.id };
  }

  /** Solo el suyo: otra persona no puede apagarle los avisos a nadie. */
  async removeDevice(userId: string, endpoint: string) {
    const { count } = await this.prisma.platformPushSubscription.updateMany({
      where: { userId, endpoint },
      data: { isActive: false, lastSeenAt: new Date() },
    });
    return { updated: count };
  }

  async sendTest(userId: string): Promise<PushResult> {
    const result = await this.sendPush(
      {
        title: 'Lynko · Plataforma',
        body: 'Tus avisos de cobro están conectados en este dispositivo.',
        url: ALERTS_PAGE,
        data: { type: 'platform.test' },
      },
      userId,
    );
    if (!result.sent && !result.failed && !result.inactive) {
      throw new BadRequestException({
        code: 'NO_ACTIVE_WEB_PUSH_SUBSCRIPTIONS',
        message: 'No hay dispositivos activos para este usuario',
      });
    }
    return result;
  }

  /** A los super-admin activos, salvo que se pida uno. Nunca lanza por un dispositivo. */
  private async sendPush(
    message: {
      title: string;
      body: string;
      url: string;
      data: Record<string, unknown>;
    },
    onlyUserId?: string,
  ): Promise<PushResult> {
    const result: PushResult = { sent: 0, failed: 0, inactive: 0 };
    if (!this.webPush.isConfigured()) {
      if (onlyUserId) this.webPush.getPublicKey();
      this.logger.warn('Avisos de cobro sin push: faltan las claves VAPID');
      return result;
    }
    const admins = await this.prisma.user.findMany({
      where: {
        isPlatformAdmin: true,
        isActive: true,
        ...(onlyUserId ? { id: onlyUserId } : {}),
      },
      select: { id: true },
    });
    const devices = await this.prisma.platformPushSubscription.findMany({
      where: { userId: { in: admins.map((a) => a.id) }, isActive: true },
    });
    for (const device of devices) {
      try {
        await this.webPush.send(
          {
            endpoint: device.endpoint,
            p256dh: device.p256dh,
            auth: device.auth,
          },
          message,
        );
        result.sent += 1;
      } catch (error) {
        const statusCode = (error as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          result.inactive += 1;
          await this.prisma.platformPushSubscription.update({
            where: { id: device.id },
            data: { isActive: false, lastSeenAt: new Date() },
          });
        } else {
          result.failed += 1;
          this.logger.warn(
            `Push de plataforma falló: ${error instanceof Error ? error.message : 'desconocido'}`,
          );
        }
      }
    }
    return result;
  }
}
