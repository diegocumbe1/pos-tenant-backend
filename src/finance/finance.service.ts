import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ExpenseFrequency, PayFrequency, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { COMPLETED_STATUS_VARIANTS } from '../barber/shared/appointment-status';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { accumulateBuckets } from './expense-buckets';
import { Period, PeriodQueryDto } from './dto/period-query.dto';
import { PayrollQueryDto } from './dto/payroll-query.dto';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';
import { CreatePayrollDto, UpdatePayrollDto } from './dto/payroll.dto';
import {
  CreateFinanceGoalDto,
  UpdateFinanceGoalDto,
} from './dto/finance-goal.dto';
import {
  calendarDayCO,
  calendarMonthCO,
  dayEndCO,
  dayStartCO,
  monthEndDayCO,
  monthStartDayCO,
  weekStartDayCO,
} from '../common/date.util';

interface Range {
  from: Date;
  to: Date;
  label: Period;
}

type FinanceVertical = 'restaurant' | 'barber' | 'retail' | 'unknown';
type DashboardSplit = Prisma.PaymentSplitGetPayload<{
  include: {
    items: true;
    order: { select: { waiterId: true } };
  };
}>;
/**
 * Acumulador de costo de lo vendido.
 *
 * `unknownRevenueCOP` no es un detalle: es la venta cuyo costo NO conocemos
 * (producto sin receta, cita anterior al congelado, orden vieja). Sin ese
 * número, un margen calculado sobre cobertura parcial se ve idéntico a uno
 * completo, y es exactamente así como un dashboard reporta utilidad inflada.
 */
interface CogsAccumulator {
  cogsCOP: number;
  knownRevenueCOP: number;
  unknownRevenueCOP: number;
}
type DashboardBarberAppointment = Prisma.BarberAppointmentGetPayload<{
  include: {
    service: { select: { id: true; name: true; priceCOP: true; costCOP: true } };
  };
}>;
type DashboardRetailSale = Prisma.RetailSaleGetPayload<{
  include: { items: true };
}>;
type RevenueBarberAppointment = Prisma.BarberAppointmentGetPayload<{
  include: { service: { select: { priceCOP: true } } };
}>;



@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboard(ctx: TenantContext, query: PeriodQueryDto) {
    const range = this.resolveRange(query);
    const vertical = await this.resolveTenantVertical(ctx);
    const includeRestaurant = vertical === 'restaurant' || vertical === 'unknown';
    const includeBarber = vertical === 'barber' || vertical === 'unknown';
    const includeRetail = vertical === 'retail' || vertical === 'unknown';

    const [splits, expenses, barberAppointments, retailSales] =
      await Promise.all([
        includeRestaurant
          ? this.prisma.paymentSplit.findMany({
              where: {
                tenantId: ctx.tenantId,
                order: { branchId: ctx.branchId },
                paidAt: { gte: range.from, lte: range.to },
              },
              include: {
                items: true,
                order: { select: { waiterId: true } },
              },
            })
          : Promise.resolve([] as DashboardSplit[]),
        this.prisma.expense.aggregate({
          where: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            incurredAt: { gte: range.from, lte: range.to },
          },
          _sum: { amountCOP: true },
        }),
        includeBarber
          ? this.prisma.barberAppointment.findMany({
              where: {
                tenantId: ctx.tenantId,
                branchId: ctx.branchId,
                status: { in: COMPLETED_STATUS_VARIANTS },
                scheduledAt: { gte: range.from, lte: range.to },
              },
              include: {
                service: {
                  select: { id: true, name: true, priceCOP: true, costCOP: true },
                },
              },
            })
          : Promise.resolve([] as DashboardBarberAppointment[]),
        includeRetail
          ? this.prisma.retailSale.findMany({
              where: {
                tenantId: ctx.tenantId,
                branchId: ctx.branchId,
                status: 'COMPLETED',
                soldAt: { gte: range.from, lte: range.to },
              },
              include: { items: true },
            })
          : Promise.resolve([] as DashboardRetailSale[]),
      ]);

    // El precio congelado en la cita manda sobre el del catálogo: reprecio o
    // renombrar un servicio no debe reescribir el histórico. Las citas
    // anteriores al congelado caen al precio actual, como antes.
    const barberRevenue = barberAppointments.reduce(
      (acc, a) => acc + (a.priceCOP ?? a.service?.priceCOP ?? 0),
      0,
    );

    const retailRevenue = retailSales.reduce(
      (acc, sale) => acc + sale.totalCOP,
      0,
    );

    const revenue =
      splits.reduce((acc, s) => acc + s.totalCOP, 0) +
      barberRevenue +
      retailRevenue;
    const expensesTotal = expenses._sum.amountCOP ?? 0;

    // ── Costo de lo vendido ────────────────────────────────────────────────
    const cogs = this.accumulateCogs(splits, barberAppointments, retailSales);
    const cogsCOP = cogs.cogsCOP;
    const grossProfitCOP = revenue - cogsCOP;
    const grossMarginPct =
      revenue > 0 ? Math.round((grossProfitCOP / revenue) * 1000) / 10 : 0;
    const netProfitCOP = revenue - cogsCOP - expensesTotal;
    const netMarginPct =
      revenue > 0 ? Math.round((netProfitCOP / revenue) * 1000) / 10 : 0;
    const coverageBase = cogs.knownRevenueCOP + cogs.unknownRevenueCOP;
    const cogsCoveragePct =
      coverageBase > 0
        ? Math.round((cogs.knownRevenueCOP / coverageBase) * 1000) / 10
        : 0;

    // `profit` y `profitMarginPct` se mantienen con su significado ANTERIOR
    // (ingreso − gastos, sin costo) para no romper a quien ya los consume. La
    // utilidad de verdad viaja en netProfitCOP.
    const profit = revenue - expensesTotal;
    const profitMarginPct =
      revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0;

    // "Órdenes" = tickets de restaurante + citas de barber + ventas de tienda.
    const ordersCount =
      new Set(splits.map((s) => s.orderId)).size +
      barberAppointments.length +
      retailSales.length;
    const averageOrderValue =
      ordersCount > 0 ? Math.round(revenue / ordersCount) : 0;

    const productMap = new Map<
      string,
      { name: string; revenue: number; quantity: number }
    >();
    for (const split of splits) {
      for (const item of split.items) {
        const entry = productMap.get(item.productId) ?? {
          name: item.name,
          revenue: 0,
          quantity: 0,
        };
        entry.revenue += item.priceCOP * item.qty;
        entry.quantity += item.qty;
        productMap.set(item.productId, entry);
      }
    }
    // Servicios de barber como "productos" en el top de ingresos.
    for (const appt of barberAppointments) {
      if (!appt.service) continue;
      const entry = productMap.get(appt.service.id) ?? {
        name: appt.service.name,
        revenue: 0,
        quantity: 0,
      };
      entry.revenue += appt.service.priceCOP;
      entry.quantity += 1;
      productMap.set(appt.service.id, entry);
    }
    // Productos vendidos en tienda: el snapshot de la línea manda sobre el catálogo.
    for (const sale of retailSales) {
      for (const item of sale.items) {
        const entry = productMap.get(item.productId) ?? {
          name: item.name,
          revenue: 0,
          quantity: 0,
        };
        entry.revenue += item.totalCOP;
        entry.quantity += item.quantity;
        productMap.set(item.productId, entry);
      }
    }
    const topProductsByRevenue = [...productMap.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const waiterAgg = new Map<
      string,
      { revenue: number; orderIds: Set<string> }
    >();
    for (const split of splits) {
      const waiterId = split.order.waiterId;
      if (!waiterId) continue;
      const entry = waiterAgg.get(waiterId) ?? {
        revenue: 0,
        orderIds: new Set(),
      };
      entry.revenue += split.totalCOP;
      entry.orderIds.add(split.orderId);
      waiterAgg.set(waiterId, entry);
    }
    const waiterIds = [...waiterAgg.keys()];
    const waiters = waiterIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: waiterIds } },
          select: { id: true, name: true },
        })
      : [];
    const waiterNames = new Map(waiters.map((w) => [w.id, w.name]));
    const topWaitersByRevenue = [...waiterAgg.entries()]
      .map(([userId, v]) => ({
        userId,
        name: waiterNames.get(userId) ?? 'Unknown',
        revenue: v.revenue,
        ordersCount: v.orderIds.size,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    // Desglose diario (hora Colombia) — restaurante (splits) + barber (citas).
    // Alimenta el chart "Ventas diarias" y el pacing de metas.
    const dayFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const dayAgg = new Map<
      string,
      { revenue: number; orderIds: Set<string>; items: number }
    >();
    const bumpDay = (
      date: Date,
      amount: number,
      orderId: string,
      items: number,
    ) => {
      const key = dayFmt.format(date);
      const entry = dayAgg.get(key) ?? {
        revenue: 0,
        orderIds: new Set<string>(),
        items: 0,
      };
      entry.revenue += amount;
      entry.orderIds.add(orderId);
      entry.items += items;
      dayAgg.set(key, entry);
    };
    for (const split of splits) {
      const itemQty = split.items.reduce((a, i) => a + i.qty, 0);
      bumpDay(split.paidAt, split.totalCOP, split.orderId, itemQty);
    }
    for (const appt of barberAppointments) {
      bumpDay(appt.scheduledAt, appt.service?.priceCOP ?? 0, appt.id, 1);
    }
    for (const sale of retailSales) {
      const units = sale.items.reduce((a, i) => a + i.quantity, 0);
      bumpDay(sale.soldAt, sale.totalCOP, sale.id, units);
    }
    const revenueByDay = [...dayAgg.entries()]
      .map(([date, v]) => ({
        date,
        revenue: v.revenue,
        orders: v.orderIds.size,
        items: v.items,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Gasto por categoría: el mapeo a los buckets que dibuja la pantalla de
    // rentabilidad se define AQUÍ, una sola vez, y viaja en la respuesta. Antes
    // el frontend recibía un único entero y por eso el punto de equilibrio
    // salía en $0.
    const expensesByCategory = await this.expenseBreakdown(
      ctx,
      range.from,
      range.to,
    );

    return {
      revenue,
      expenses: expensesTotal,
      profit,
      profitMarginPct,
      ordersCount,
      averageOrderValue,
      topProductsByRevenue,
      topWaitersByRevenue,
      revenueByDay,
      // ── Costo real de lo vendido (aditivo) ──
      cogsCOP,
      grossProfitCOP,
      grossMarginPct,
      netProfitCOP,
      netMarginPct,
      cogsCoveragePct,
      uncostedRevenueCOP: cogs.unknownRevenueCOP,
      expensesByCategory,
      expenseBuckets: accumulateBuckets(expensesByCategory),
      period: range.label,
      dateFrom: range.from.toISOString(),
      dateTo: range.to.toISOString(),
    };
  }

  /**
   * Suma el costo congelado de las tres verticales y, en paralelo, cuánta venta
   * quedó sin costo conocido.
   *
   * Regla que sostiene todo el cálculo: costo `null` NO es costo cero. Una orden
   * sin receta cargada no aporta al COGS y su ingreso se marca como no costeado,
   * para que el margen resultante se pueda leer junto a su cobertura.
   */
  private accumulateCogs(
    splits: DashboardSplit[],
    appointments: DashboardBarberAppointment[],
    retailSales: DashboardRetailSale[],
  ): CogsAccumulator {
    const acc: CogsAccumulator = {
      cogsCOP: 0,
      knownRevenueCOP: 0,
      unknownRevenueCOP: 0,
    };

    // Restaurante: costo por línea de pago, congelado al enviar a cocina.
    for (const split of splits) {
      for (const item of split.items) {
        const lineRevenue = item.priceCOP * item.qty;
        if (item.unitCostCOP === null) {
          acc.unknownRevenueCOP += lineRevenue;
          continue;
        }
        acc.cogsCOP += item.unitCostCOP * item.qty;
        acc.knownRevenueCOP += lineRevenue;
      }
    }

    // Barbería: costo congelado al completar la cita.
    for (const appt of appointments) {
      const apptRevenue = appt.priceCOP ?? appt.service?.priceCOP ?? 0;
      if (appt.costCOP === null) {
        acc.unknownRevenueCOP += apptRevenue;
        continue;
      }
      acc.cogsCOP += appt.costCOP;
      acc.knownRevenueCOP += apptRevenue;
    }

    // Tiendas: el costo ya venía congelado desde que existe el modelo, así que
    // esta vertical siempre tiene cobertura completa.
    for (const sale of retailSales) {
      acc.cogsCOP += sale.costCOP;
      acc.knownRevenueCOP += sale.totalCOP;
    }

    return acc;
  }

  /**
   * Saldo de caja del rango. Solo lectura sobre CashSession/CashMovement.
   *
   * Existe aquí, y no en el módulo de cash-sessions, a propósito: mover ese
   * módulo fuera de `restaurant/` toca el POS y no es crítico hoy. Este endpoint
   * únicamente lee, así que no interfiere con el arqueo.
   *
   * `hasCashTracking: false` significa que la vertical no lleva caja (barbería
   * hoy). El frontend debe mostrar "sin datos" — nunca un cero que se lee como
   * "caja vacía".
   */
  async cashBalance(ctx: TenantContext, query: PeriodQueryDto) {
    const range = this.resolveRange(query);
    const sessions = await this.prisma.cashSession.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        openedAt: { lte: range.to },
        OR: [{ closedAt: null }, { closedAt: { gte: range.from } }],
      },
      include: { movements: true },
      orderBy: { openedAt: 'desc' },
    });

    // El signo lo define el tipo de movimiento, igual que en CashSessionsService.
    const OUTFLOW = new Set(['REFUND', 'EXPENSE', 'WITHDRAWAL']);
    let expectedCashCOP = 0;
    let countedCashCOP = 0;
    let differenceCOP = 0;
    let openSessions = 0;
    let lastClosedAt: Date | null = null;

    for (const session of sessions) {
      if (session.status === 'OPEN') {
        openSessions += 1;
        for (const m of session.movements) {
          if (m.method !== 'cash') continue;
          expectedCashCOP += OUTFLOW.has(m.type) ? -m.amount : m.amount;
        }
      } else {
        expectedCashCOP += session.expectedAmount ?? 0;
        countedCashCOP += session.countedAmount ?? 0;
        differenceCOP += session.difference ?? 0;
        if (
          session.closedAt &&
          (!lastClosedAt || session.closedAt > lastClosedAt)
        ) {
          lastClosedAt = session.closedAt;
        }
      }
    }

    return {
      hasCashTracking: sessions.length > 0,
      openSessions,
      expectedCashCOP,
      countedCashCOP,
      differenceCOP,
      lastClosedAt: lastClosedAt ? lastClosedAt.toISOString() : null,
      period: range.label,
      dateFrom: range.from.toISOString(),
      dateTo: range.to.toISOString(),
    };
  }

  /** Gasto agrupado por categoría en un rango. Espeja `expenses()`. */
  private async expenseBreakdown(ctx: TenantContext, from: Date, to: Date) {
    const rows = await this.prisma.expense.groupBy({
      by: ['category'],
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        incurredAt: { gte: from, lte: to },
      },
      _sum: { amountCOP: true },
    });
    return rows
      .map((row) => ({
        category: row.category,
        amountCOP: row._sum.amountCOP ?? 0,
      }))
      .sort((a, b) => b.amountCOP - a.amountCOP);
  }

  async expenses(ctx: TenantContext, query: PeriodQueryDto) {
    const range = this.resolveRange(query);
    const rows = await this.prisma.expense.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        incurredAt: { gte: range.from, lte: range.to },
      },
      orderBy: { incurredAt: 'desc' },
    });

    const byCategory = new Map<string, number>();
    let total = 0;
    for (const e of rows) {
      total += e.amountCOP;
      byCategory.set(
        e.category,
        (byCategory.get(e.category) ?? 0) + e.amountCOP,
      );
    }

    return {
      total,
      byCategory: [...byCategory.entries()].map(([category, amount]) => ({
        category,
        amountCOP: amount,
      })),
      expenses: rows.map((e) => this.toExpenseDto(e)),
      period: range.label,
      dateFrom: range.from.toISOString(),
      dateTo: range.to.toISOString(),
    };
  }

  async payroll(ctx: TenantContext, query: PayrollQueryDto) {
    const periodMonth = query.period ?? this.currentPeriodMonth();
    const rows = await this.prisma.payroll.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        periodMonth,
      },
      orderBy: { staffName: 'asc' },
    });

    const entries = rows.map((r) => {
      // grossCOP/netCOP se guardan POR PERÍODO de pago. Según la frecuencia,
      // multiplicamos por los ciclos de pago que caen en el mes.
      const cyclesInMonth = this.payCyclesInMonth(periodMonth, r.payFrequency);
      return {
        id: r.id,
        userId: r.userId,
        staffName: r.staffName,
        role: r.role,
        payFrequency: r.payFrequency,
        // Por período de pago
        grossCOP: r.grossCOP,
        netCOP: r.netCOP,
        bonusesCOP: r.bonusesCOP,
        deductionsCOP: r.deductionsCOP,
        // Consolidado del mes (frecuencia × ciclos)
        cyclesInMonth,
        monthlyGrossCOP: r.grossCOP * cyclesInMonth,
        monthlyNetCOP: r.netCOP * cyclesInMonth,
        paidAt: r.paidAt?.getTime() ?? null,
      };
    });

    const grossTotal = entries.reduce((a, e) => a + e.monthlyGrossCOP, 0);
    const netTotal = entries.reduce((a, e) => a + e.monthlyNetCOP, 0);

    // Límites del mes en hora Colombia (con TZ=America/Bogota el constructor local
    // arranca a medianoche Bogotá; new Date(y, m, 1) normaliza el cambio de año).
    const [pmYear, pmMonth] = periodMonth.split('-').map(Number);
    const monthStart = new Date(pmYear, pmMonth - 1, 1, 0, 0, 0, 0);
    const monthEnd = new Date(pmYear, pmMonth, 1, 0, 0, 0, 0);

    return {
      periodMonth,
      grossTotal,
      netTotal,
      entries,
      dateFrom: monthStart.toISOString(),
      dateTo: monthEnd.toISOString(),
    };
  }

  async goals(ctx: TenantContext, query: PeriodQueryDto) {
    const { periodMonth } = this.resolvePayrollMonth(query);
    const vertical = await this.resolveTenantVertical(ctx);
    const goals = await this.prisma.financeGoal.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId, periodMonth },
    });

    // Horarios del negocio → días operativos (barber). Restaurante/sin datos = todos.
    const settings =
      vertical === 'barber'
        ? await this.prisma.barberSettings
            .findUnique({
              where: { branchId: ctx.branchId },
              select: { businessHours: true },
            })
            .catch(() => null)
        : null;
    const hours =
      (settings?.businessHours as Record<string, unknown> | null) ?? null;

    const enriched = await Promise.all(
      goals.map(async (g) => {
        const { from, to } = this.goalRange(g, periodMonth);
        const revenue = await this.revenueInRange(ctx, from, to, vertical);
        const actualCOP =
          g.metric === 'revenue'
            ? revenue
            : revenue - (await this.expensesInRange(ctx, from, to));

        const { total, elapsed } = this.countOperatingDays(from, to, hours);
        const timeProgressPct =
          total > 0 ? Math.round((elapsed / total) * 1000) / 10 : 0;
        const expectedToDateCOP =
          total > 0 ? Math.round(g.targetCOP * (elapsed / total)) : 0;
        const progressPct =
          g.targetCOP > 0
            ? Math.round((actualCOP / g.targetCOP) * 1000) / 10
            : 0;
        const remainingDays = Math.max(0, total - elapsed);
        const remainingTarget = Math.max(0, g.targetCOP - actualCOP);
        const dailyRequiredCOP =
          remainingDays > 0 ? Math.round(remainingTarget / remainingDays) : 0;

        // Estado: sobrado / al día / desfasado (vs esperado a la fecha).
        let paceStatus: 'AHEAD' | 'ON_TRACK' | 'BEHIND';
        if (expectedToDateCOP <= 0) {
          paceStatus = actualCOP > 0 ? 'AHEAD' : 'ON_TRACK';
        } else if (actualCOP >= expectedToDateCOP * 1.05) {
          paceStatus = 'AHEAD';
        } else if (actualCOP >= expectedToDateCOP * 0.9) {
          paceStatus = 'ON_TRACK';
        } else {
          paceStatus = 'BEHIND';
        }

        return {
          id: g.id,
          metric: g.metric,
          targetCOP: g.targetCOP,
          periodType: g.periodType,
          periodStart: from.getTime(),
          periodEnd: to.getTime(),
          actualCOP,
          expectedToDateCOP,
          progressPct,
          timeProgressPct,
          dailyRequiredCOP,
          operatingDaysElapsed: elapsed,
          operatingDaysTotal: total,
          paceStatus,
        };
      }),
    );

    return { periodMonth, goals: enriched };
  }

  // Rango [from, to) de una meta: usa el rango explícito o deriva del mes ancla.
  private goalRange(
    g: {
      periodStart: Date | null;
      periodEnd: Date | null;
      periodMonth: string;
    },
    fallbackMonth: string,
  ): { from: Date; to: Date } {
    if (g.periodStart && g.periodEnd) {
      return { from: g.periodStart, to: g.periodEnd };
    }
    const [y, m] = (g.periodMonth || fallbackMonth).split('-').map(Number);
    return {
      from: new Date(y, m - 1, 1, 0, 0, 0, 0),
      to: new Date(y, m, 1, 0, 0, 0, 0),
    };
  }

  // Cuenta días operativos totales y transcurridos (hasta hoy) en [from, to).
  // hours = businessHours { monday: [{start,end}], ... }; lista vacía = cerrado.
  private countOperatingDays(
    from: Date,
    to: Date,
    hours: Record<string, unknown> | null,
  ): { total: number; elapsed: number } {
    const WEEK = [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ];
    const isOpen = (d: Date): boolean => {
      if (!hours) return true;
      const v = hours[WEEK[d.getDay()]];
      if (v === undefined) return true;
      return Array.isArray(v) ? v.length > 0 : !!v;
    };
    const now = new Date();
    let total = 0;
    let elapsed = 0;
    const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    while (cur < to) {
      if (isOpen(cur)) {
        total += 1;
        if (cur <= now) elapsed += 1;
      }
      cur.setDate(cur.getDate() + 1);
    }
    return { total, elapsed };
  }

  // Ingreso en un rango: splits (restaurante) + citas completadas (barber)
  // + ventas de mostrador (retail). Cada vertical aporta 0 si no aplica.
  private async revenueInRange(
    ctx: TenantContext,
    from: Date,
    to: Date,
    vertical: FinanceVertical = 'unknown',
  ): Promise<number> {
    const includeRestaurant = vertical === 'restaurant' || vertical === 'unknown';
    const includeBarber = vertical === 'barber' || vertical === 'unknown';
    const includeRetail = vertical === 'retail' || vertical === 'unknown';

    const [splitAgg, appts, retailAgg] = await Promise.all([
      includeRestaurant
        ? this.prisma.paymentSplit.aggregate({
            where: {
              tenantId: ctx.tenantId,
              order: { branchId: ctx.branchId },
              paidAt: { gte: from, lt: to },
            },
            _sum: { totalCOP: true },
          })
        : Promise.resolve({ _sum: { totalCOP: 0 } }),
      includeBarber
        ? this.prisma.barberAppointment.findMany({
            where: {
              tenantId: ctx.tenantId,
              branchId: ctx.branchId,
              status: { in: COMPLETED_STATUS_VARIANTS },
              scheduledAt: { gte: from, lt: to },
            },
            include: { service: { select: { priceCOP: true } } },
          })
        : Promise.resolve([] as RevenueBarberAppointment[]),
      includeRetail
        ? this.prisma.retailSale.aggregate({
            where: {
              tenantId: ctx.tenantId,
              branchId: ctx.branchId,
              status: 'COMPLETED',
              soldAt: { gte: from, lt: to },
            },
            _sum: { totalCOP: true },
          })
        : Promise.resolve({ _sum: { totalCOP: 0 } }),
    ]);
    // Mismo criterio que el dashboard: manda el precio congelado en la cita.
    const barber = appts.reduce(
      (a, x) => a + (x.priceCOP ?? x.service?.priceCOP ?? 0),
      0,
    );
    return (
      (splitAgg._sum.totalCOP ?? 0) + barber + (retailAgg._sum.totalCOP ?? 0)
    );
  }

  private async expensesInRange(
    ctx: TenantContext,
    from: Date,
    to: Date,
  ): Promise<number> {
    const agg = await this.prisma.expense.aggregate({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        incurredAt: { gte: from, lt: to },
      },
      _sum: { amountCOP: true },
    });
    return agg._sum.amountCOP ?? 0;
  }

  private async resolveTenantVertical(ctx: TenantContext): Promise<FinanceVertical> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: { vertical: { select: { code: true } } },
    });
    const code = tenant?.vertical?.code;
    if (code === 'restaurant' || code === 'barber' || code === 'retail') {
      return code;
    }
    return 'unknown';
  }

  // Resuelve periodType + rango al crear/editar una meta.
  private resolveGoalPeriod(dto: CreateFinanceGoalDto): {
    periodType: string;
    periodStart: Date;
    periodEnd: Date;
  } {
    const periodType = dto.periodType ?? 'MONTHLY';
    if (dto.periodStart && dto.periodEnd) {
      return {
        periodType,
        periodStart: new Date(dto.periodStart),
        periodEnd: new Date(dto.periodEnd),
      };
    }
    const [y, m] = dto.periodMonth.split('-').map(Number);
    return {
      periodType,
      periodStart: new Date(y, m - 1, 1, 0, 0, 0, 0),
      periodEnd: new Date(y, m, 1, 0, 0, 0, 0),
    };
  }

  // ─── Gastos (write) ──────────────────────────────────────────────────────

  async createExpense(ctx: TenantContext, dto: CreateExpenseDto) {
    const expense = await this.prisma.expense.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        category: dto.category,
        concept: dto.concept,
        amountCOP: dto.amountCOP,
        incurredAt: new Date(dto.incurredAt),
        frequency: dto.frequency ?? ExpenseFrequency.ONE_TIME,
        isRecurring: dto.isRecurring ?? false,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        note: dto.note ?? null,
      },
    });
    return this.toExpenseDto(expense);
  }

  async updateExpense(ctx: TenantContext, id: string, dto: UpdateExpenseDto) {
    await this.assertExpense(ctx, id);
    const expense = await this.prisma.expense.update({
      where: { id },
      data: {
        category: dto.category,
        concept: dto.concept,
        amountCOP: dto.amountCOP,
        incurredAt:
          dto.incurredAt !== undefined ? new Date(dto.incurredAt) : undefined,
        frequency: dto.frequency,
        isRecurring: dto.isRecurring,
        dueDate:
          dto.dueDate !== undefined
            ? dto.dueDate
              ? new Date(dto.dueDate)
              : null
            : undefined,
        note: dto.note,
      },
    });
    return this.toExpenseDto(expense);
  }

  async removeExpense(ctx: TenantContext, id: string) {
    await this.assertExpense(ctx, id);
    await this.prisma.expense.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Nómina (write) ──────────────────────────────────────────────────────

  async createPayroll(ctx: TenantContext, dto: CreatePayrollDto) {
    try {
      const row = await this.prisma.payroll.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          userId: dto.userId ?? null,
          staffName: dto.staffName,
          role: dto.role,
          periodMonth: dto.periodMonth,
          payFrequency: dto.payFrequency ?? PayFrequency.MONTHLY,
          grossCOP: dto.grossCOP,
          netCOP: dto.netCOP,
          bonusesCOP: dto.bonusesCOP ?? 0,
          deductionsCOP: dto.deductionsCOP ?? 0,
          paidAt: dto.paidAt ? new Date(dto.paidAt) : null,
        },
      });
      return this.toPayrollDto(row);
    } catch (err) {
      throw this.mapUniqueViolation(
        err,
        'A payroll entry already exists for this staff and period',
      );
    }
  }

  async updatePayroll(ctx: TenantContext, id: string, dto: UpdatePayrollDto) {
    await this.assertPayroll(ctx, id);
    try {
      const row = await this.prisma.payroll.update({
        where: { id },
        data: {
          userId: dto.userId,
          staffName: dto.staffName,
          role: dto.role,
          periodMonth: dto.periodMonth,
          payFrequency: dto.payFrequency,
          grossCOP: dto.grossCOP,
          netCOP: dto.netCOP,
          bonusesCOP: dto.bonusesCOP,
          deductionsCOP: dto.deductionsCOP,
          paidAt:
            dto.paidAt === undefined
              ? undefined
              : dto.paidAt === null
                ? null
                : new Date(dto.paidAt),
        },
      });
      return this.toPayrollDto(row);
    } catch (err) {
      throw this.mapUniqueViolation(
        err,
        'A payroll entry already exists for this staff and period',
      );
    }
  }

  async removePayroll(ctx: TenantContext, id: string) {
    await this.assertPayroll(ctx, id);
    await this.prisma.payroll.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Metas (write) ───────────────────────────────────────────────────────

  async createGoal(ctx: TenantContext, dto: CreateFinanceGoalDto) {
    try {
      const { periodType, periodStart, periodEnd } =
        this.resolveGoalPeriod(dto);
      const goal = await this.prisma.financeGoal.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          periodMonth: dto.periodMonth,
          metric: dto.metric,
          targetCOP: dto.targetCOP,
          periodType,
          periodStart,
          periodEnd,
        },
      });
      return this.toGoalDto(goal);
    } catch (err) {
      throw this.mapUniqueViolation(
        err,
        'A goal already exists for this metric and period',
      );
    }
  }

  async updateGoal(ctx: TenantContext, id: string, dto: UpdateFinanceGoalDto) {
    await this.assertGoal(ctx, id);
    try {
      const period =
        dto.periodMonth !== undefined
          ? this.resolveGoalPeriod(dto as CreateFinanceGoalDto)
          : null;
      const goal = await this.prisma.financeGoal.update({
        where: { id },
        data: {
          periodMonth: dto.periodMonth,
          metric: dto.metric,
          targetCOP: dto.targetCOP,
          ...(period
            ? {
                periodType: period.periodType,
                periodStart: period.periodStart,
                periodEnd: period.periodEnd,
              }
            : {}),
        },
      });
      return this.toGoalDto(goal);
    } catch (err) {
      throw this.mapUniqueViolation(
        err,
        'A goal already exists for this metric and period',
      );
    }
  }

  async removeGoal(ctx: TenantContext, id: string) {
    await this.assertGoal(ctx, id);
    await this.prisma.financeGoal.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Helpers de escritura ────────────────────────────────────────────────

  private async assertExpense(ctx: TenantContext, id: string) {
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException(`Expense ${id} not found`);
  }

  private async assertPayroll(ctx: TenantContext, id: string) {
    const row = await this.prisma.payroll.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException(`Payroll ${id} not found`);
  }

  private async assertGoal(ctx: TenantContext, id: string) {
    const row = await this.prisma.financeGoal.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException(`Goal ${id} not found`);
  }

  private mapUniqueViolation(err: unknown, message: string) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return new ConflictException(message);
    }
    return err;
  }

  private toExpenseDto(e: {
    id: string;
    category: string;
    concept: string;
    amountCOP: number;
    incurredAt: Date;
    frequency: ExpenseFrequency;
    isRecurring: boolean;
    dueDate: Date | null;
    note: string | null;
  }) {
    return {
      id: e.id,
      category: e.category,
      concept: e.concept,
      amountCOP: e.amountCOP,
      incurredAt: e.incurredAt.getTime(),
      frequency: e.frequency,
      isRecurring: e.isRecurring,
      dueDate: e.dueDate ? e.dueDate.getTime() : null,
      note: e.note,
    };
  }

  private toPayrollDto(r: {
    id: string;
    userId: string | null;
    staffName: string;
    role: string;
    periodMonth: string;
    payFrequency: PayFrequency;
    grossCOP: number;
    netCOP: number;
    bonusesCOP: number;
    deductionsCOP: number;
    paidAt: Date | null;
  }) {
    const cyclesInMonth = this.payCyclesInMonth(r.periodMonth, r.payFrequency);
    return {
      id: r.id,
      userId: r.userId,
      staffName: r.staffName,
      role: r.role,
      periodMonth: r.periodMonth,
      payFrequency: r.payFrequency,
      grossCOP: r.grossCOP,
      netCOP: r.netCOP,
      bonusesCOP: r.bonusesCOP,
      deductionsCOP: r.deductionsCOP,
      cyclesInMonth,
      monthlyGrossCOP: r.grossCOP * cyclesInMonth,
      monthlyNetCOP: r.netCOP * cyclesInMonth,
      paidAt: r.paidAt?.getTime() ?? null,
    };
  }

  private toGoalDto(g: {
    id: string;
    periodMonth: string;
    metric: string;
    targetCOP: number;
    periodType: string;
    periodStart: Date | null;
    periodEnd: Date | null;
  }) {
    return {
      id: g.id,
      periodMonth: g.periodMonth,
      metric: g.metric,
      targetCOP: g.targetCOP,
      periodType: g.periodType,
      periodStart: g.periodStart ? g.periodStart.getTime() : null,
      periodEnd: g.periodEnd ? g.periodEnd.getTime() : null,
    };
  }

  private resolveRange(query: PeriodQueryDto): Range {
    const period = query.period ?? 'today';
    const now = new Date();

    if (period === 'custom') {
      if (!query.dateFrom || !query.dateTo) {
        throw new UnprocessableEntityException(
          'dateFrom and dateTo required when period=custom',
        );
      }
      return {
        from: new Date(query.dateFrom),
        to: new Date(query.dateTo),
        label: 'custom',
      };
    }

    // Los bordes se derivan del CALENDARIO colombiano, no del reloj del proceso:
    // main.ts respeta el TZ del host, así que un contenedor en UTC corría todos
    // los rangos cinco horas.
    const today = calendarDayCO(now);
    let fromDay = today;
    let toDay = today;

    if (period === 'week') {
      fromDay = weekStartDayCO(now);
    } else if (period === 'month') {
      fromDay = monthStartDayCO(now);
      toDay = monthEndDayCO(now);
    }

    return { from: dayStartCO(fromDay), to: dayEndCO(toDay), label: period };
  }

  private resolvePayrollMonth(query: PeriodQueryDto) {
    const range = this.resolveRange(query);
    const periodMonth = calendarMonthCO(range.from);
    return { periodMonth, range };
  }

  private currentPeriodMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Ciclos de pago que caen dentro del mes según la frecuencia.
   * - MONTHLY: 1
   * - BIWEEKLY (quincenal): 2
   * - WEEKLY: cuenta los viernes (día de pago) del mes → 4 o 5
   */
  private payCyclesInMonth(periodMonth: string, freq: PayFrequency): number {
    if (freq === PayFrequency.MONTHLY) return 1;
    if (freq === PayFrequency.BIWEEKLY) return 2;

    const [year, month] = periodMonth.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    let fridays = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === 5) fridays++;
    }
    return fridays;
  }
}
