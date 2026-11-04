import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  addCalendarDaysCO,
  calendarDayCO,
  clockTimeCO,
  formatCOP,
  dayStartCO,
} from '../../../common/date.util';
import {
  NotificationDispatcherService,
  type DispatchParams,
} from '../../../notifications/notification-dispatcher.service';
import { PrismaService } from '../../../prisma/prisma.service';

const TICK_MS = 15 * 60_000;
/** Un aviso de plata a las 3 a. m. no le sirve a nadie. */
const FIRST_HOUR = 8;
const LAST_HOUR = 20;
const MAX_NAMES = 3;

type AlertKind = 'due' | 'missed';

interface PaymentItem {
  /** Lo que ya se avisó no se repite: compromiso, tipo de aviso y día. */
  key: string;
  tenantId: string;
  branchId: string;
  vertical: 'retail' | 'barber';
  kind: AlertKind;
  customer: string;
  amountCOP: number;
  /** Solo el día de recordar, si no es el día del pago. */
  remindOnly?: boolean;
}

const dbDay = (day: string) => new Date(`${day}T00:00:00.000Z`);
const fromDbDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Avisa al EQUIPO de la plata por cobrar: hoy toca recordarle a alguien, alguien
 * paga hoy o no pagó ayer. NO le escribe al cliente: ese mensaje lo sigue mandando
 * una persona con un toque (docs/RETAIL_GUIA_DE_USO.md §7).
 *
 * Un aviso por persona con el resumen del día, no uno por deuda. "Incumplido" sale
 * una sola vez, el día siguiente: repetirlo cada día enseñaría a ignorarlo.
 */
@Injectable()
export class PaymentAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentAlertsService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationDispatcherService,
  ) {}

  onModuleInit() {
    if (process.env.APPOINTMENT_REMINDERS_ENABLED === 'false') return;
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
      const today = calendarDayCO(now);
      const items = [
        ...(await this.retailItems(today)),
        ...(await this.barberItems(today)),
      ];
      const groups = new Map<string, PaymentItem[]>();
      for (const item of items) {
        const key = `${item.tenantId}|${item.branchId}|${item.vertical}|${item.kind}`;
        groups.set(key, [...(groups.get(key) ?? []), item]);
      }
      for (const group of groups.values()) await this.send(group, today);
    } catch (error) {
      this.logger.error(
        `Avisos de pago: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async retailItems(today: string): Promise<PaymentItem[]> {
    const yesterday = addCalendarDaysCO(today, -1);
    const commitments = await this.prisma.retailPaymentCommitment.findMany({
      where: {
        status: 'PENDING',
        dueOn: {
          gte: dbDay(yesterday),
          lte: dbDay(addCalendarDaysCO(today, 31)),
        },
      },
    });
    const relevant = commitments.flatMap((c) => {
      const dueOn = fromDbDay(c.dueOn);
      const entry = (kind: AlertKind, remindOnly: boolean) => [
        { c, kind, remindOnly },
      ];
      if (dueOn === yesterday) return entry('missed', false);
      if (dueOn === today) return entry('due', false);
      const remindOn = addCalendarDaysCO(dueOn, -c.remindDaysBefore);
      return c.remindByWhatsapp && !c.remindedAt && remindOn === today
        ? entry('due', true)
        : [];
    });
    if (!relevant.length) return [];

    const [sales, customers] = await Promise.all([
      this.prisma.retailSale.findMany({
        where: { id: { in: relevant.flatMap((r) => r.c.saleIds) } },
        select: { id: true, totalCOP: true, paidCOP: true, status: true },
      }),
      this.prisma.retailCustomer.findMany({
        where: {
          id: {
            in: relevant.flatMap((r) =>
              r.c.customerId ? [r.c.customerId] : [],
            ),
          },
        },
        select: { id: true, name: true },
      }),
    ]);
    const saleById = new Map(sales.map((s) => [s.id, s]));
    const nameById = new Map(customers.map((c) => [c.id, c.name]));

    return relevant.flatMap(({ c, kind, remindOnly }) => {
      const balance = c.saleIds.reduce((sum, id) => {
        const sale = saleById.get(id);
        if (!sale || sale.status === 'VOIDED') return sum;
        return sum + Math.max(0, sale.totalCOP - sale.paidCOP);
      }, 0);
      // Si ya pagó, no hay nada que recordar aunque el compromiso siga abierto.
      if (balance <= 0) return [];
      return [
        {
          key: `retail-commit:${c.id}:${kind}:${fromDbDay(c.dueOn)}${remindOnly ? ':remind' : ''}`,
          tenantId: c.tenantId,
          branchId: c.branchId,
          vertical: 'retail' as const,
          kind,
          customer: (c.customerId && nameById.get(c.customerId)) || 'Cliente',
          amountCOP: Math.min(balance, c.amountCOP ?? balance),
          remindOnly,
        },
      ];
    });
  }

  private async barberItems(today: string): Promise<PaymentItem[]> {
    const yesterday = addCalendarDaysCO(today, -1);
    const charges = await this.prisma.barberCharge.findMany({
      where: {
        voidedAt: null,
        dueOn: { in: [dbDay(today), dbDay(yesterday)] },
      },
      select: {
        id: true,
        tenantId: true,
        branchId: true,
        dueOn: true,
        totalCOP: true,
        customer: { select: { name: true } },
        payments: { where: { voidedAt: null }, select: { amountCOP: true } },
      },
    });
    return charges.flatMap((charge) => {
      const paid = charge.payments.reduce((s, p) => s + p.amountCOP, 0);
      const balance = charge.totalCOP - paid;
      if (balance <= 0 || !charge.dueOn) return [];
      const dueOn = fromDbDay(charge.dueOn);
      const kind: AlertKind = dueOn === today ? 'due' : 'missed';
      return [
        {
          key: `barber-charge:${charge.id}:${kind}:${dueOn}`,
          tenantId: charge.tenantId,
          branchId: charge.branchId,
          vertical: 'barber' as const,
          kind,
          customer: charge.customer?.name ?? 'Cliente',
          amountCOP: balance,
        },
      ];
    });
  }

  private async send(group: PaymentItem[], today: string) {
    const { tenantId, branchId, vertical, kind } = group[0];
    const type = `${vertical}.payment.${kind}`;
    const userIds = await this.notifications.recipientsFor({
      tenantId,
      branchId,
      type,
    });
    const scheduledAt = dayStartCO(today);

    for (const userId of userIds) {
      // Se reclama deuda por deuda: si a las 10 aparece un compromiso nuevo, llega
      // solo ese, no otra vez el resumen de las 8.
      const fresh: PaymentItem[] = [];
      for (const item of group) {
        const { count } =
          await this.prisma.appointmentReminderDelivery.createMany({
            data: [
              {
                tenantId,
                itemKey: item.key,
                userId,
                minutesBefore: 0,
                scheduledAt,
              },
            ],
            skipDuplicates: true,
          });
        if (count) fresh.push(item);
      }
      if (fresh.length) {
        await this.notifications.dispatchToUsers(
          this.message(fresh, type, today),
          [userId],
        );
      }
    }
  }

  private message(items: PaymentItem[], type: string, today: string) {
    const { tenantId, branchId, vertical, kind } = items[0];
    const total = items.reduce((s, i) => s + i.amountCOP, 0);
    const remindOnly = items.every((i) => i.remindOnly);
    const count = items.length;
    const title =
      kind === 'missed'
        ? count === 1
          ? 'Un pago no llegó ayer'
          : `${count} pagos no llegaron ayer`
        : remindOnly
          ? count === 1
            ? 'Hoy toca recordar un pago'
            : `Hoy toca recordar ${count} pagos`
          : count === 1
            ? 'Hoy vence un pago'
            : `Hoy vencen ${count} pagos`;
    const names = items
      .slice(0, MAX_NAMES)
      .map((i) => `${i.customer} ${formatCOP(i.amountCOP)}`);
    const rest = count - names.length;
    const params: DispatchParams = {
      tenantId,
      branchId,
      vertical,
      type,
      title,
      body: `${names.join(' · ')}${rest > 0 ? ` y ${rest} más` : ''} · Total ${formatCOP(total)}`,
      url:
        vertical === 'retail'
          ? `/retail/deliveries?tab=payment&filter=${kind === 'missed' ? 'broken' : remindOnly ? 'remind' : 'today'}&branch=${branchId}`
          : `/agenda/finance/sales?branch=${branchId}`,
      payload: { day: today, count },
    };
    return params;
  }
}
