import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/types/tenant-context.interface';
import { PlatformService } from '../platform/platform.service';
import { RetailInventoryService } from '../retail/modules/inventory/retail-inventory.service';
import { RetailSalesService } from '../retail/modules/sales/retail-sales.service';
import { AssistantScopeService, BusinessRef } from './assistant-scope.service';
import {
  InventoryStatusAnswer,
  PendingDeliveryAnswer,
  PendingPaymentAnswer,
  PlatformOverviewAnswer,
  SalesTodayAnswer,
} from './assistant.types';

/**
 * Capacidad de consulta compartida entre canales (Alexa, chat web).
 *
 * Responsabilidades: verificar permisos del actor y devolver cifras. La
 * redacción —hablada o en pantalla— es del canal, no de aquí.
 */
@Injectable()
export class AssistantService {
  constructor(
    private readonly platform: PlatformService,
    private readonly scope: AssistantScopeService,
    private readonly retailSales: RetailSalesService,
    private readonly retailInventory: RetailInventoryService,
  ) {}

  /**
   * Ventas de hoy en el negocio completo.
   *
   * El rango se arma en hora local (el proceso corre con TZ=America/Bogota),
   * porque "hoy" para quien pregunta es su día, no el UTC.
   *
   * Al sumar sucursales, los totales se suman pero el margen y el ticket
   * promedio se RECALCULAN: promediar promedios daría un número que no
   * corresponde a ninguna venta real.
   */
  async salesToday(
    actor: AuthenticatedUser,
    business: BusinessRef,
  ): Promise<SalesTodayAnswer> {
    const ctx = await this.scope.contextFor(actor, business.id);
    this.scope.assertPermission(ctx, 'retail:sales:read');
    const branchIds = await this.scope.branchesOf(business.id);

    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const parts = await Promise.all(
      branchIds.map((branchId) =>
        this.retailSales.getSummary(
          { ...ctx, branchId },
          start.toISOString(),
          now.toISOString(),
        ),
      ),
    );

    const sum = (pick: (p: (typeof parts)[number]) => number) =>
      parts.reduce((n, p) => n + pick(p), 0);
    const revenueCOP = sum((p) => p.revenueCOP);
    const grossProfitCOP = sum((p) => p.grossProfitCOP);
    const salesCount = sum((p) => p.salesCount);

    return {
      business,
      salesCount,
      revenueCOP,
      unitsSold: sum((p) => p.unitsSold),
      averageTicketCOP: salesCount ? Math.round(revenueCOP / salesCount) : 0,
      marginPct: revenueCOP
        ? Math.round((grossProfitCOP / revenueCOP) * 1000) / 10
        : 0,
      pendingTodayCOP: sum((p) => p.pendingPayment.amountCOP),
    };
  }

  /** Ventas cerradas que todavía no se entregaron, sin importar la fecha. */
  async pendingDelivery(
    actor: AuthenticatedUser,
    business: BusinessRef,
  ): Promise<PendingDeliveryAnswer> {
    const ctx = await this.scope.contextFor(actor, business.id);
    this.scope.assertPermission(ctx, 'retail:sales:read');
    const branchIds = await this.scope.branchesOf(business.id);
    const perBranch = await Promise.all(
      branchIds.map((branchId) =>
        this.retailSales.listSales(
          { ...ctx, branchId },
          { deliveryStatus: 'PENDING', limit: 500 },
        ),
      ),
    );

    const byCustomer = new Map<string, PendingDeliveryAnswer['customers'][0]>();
    let totalCOP = 0;
    let salesCount = 0;
    for (const sale of perBranch.flat()) {
      totalCOP += sale.totalCOP;
      salesCount += 1;
      const name = sale.customerName ?? 'Sin cliente registrado';
      const entry = byCustomer.get(name) ?? {
        name,
        salesCount: 0,
        totalCOP: 0,
      };
      entry.salesCount += 1;
      entry.totalCOP += sale.totalCOP;
      byCustomer.set(name, entry);
    }

    return {
      business,
      salesCount,
      totalCOP,
      customers: [...byCustomer.values()].sort(
        (a, b) => b.totalCOP - a.totalCOP,
      ),
    };
  }

  /**
   * Estado del inventario del negocio completo.
   *
   * `getSummary` es por sucursal, así que se corre una vez por cada una y se
   * suma. En paralelo: son round-trips a Supabase y la latencia se nota.
   */
  async inventoryStatus(
    actor: AuthenticatedUser,
    business: BusinessRef,
  ): Promise<InventoryStatusAnswer> {
    const ctx = await this.scope.contextFor(actor, business.id);
    this.scope.assertPermission(ctx, 'retail:inventory:read');
    const branchIds = await this.scope.branchesOf(business.id);
    const parts = await Promise.all(
      branchIds.map((branchId) =>
        this.retailInventory.getSummary({ ...ctx, branchId }),
      ),
    );

    const lowStock = parts
      .flatMap((p) => p.lowStock)
      .sort((a, b) => a.stock - b.stock)
      .map(({ name, stock, minStock }) => ({ name, stock, minStock }));

    return {
      business,
      trackedProducts: parts.reduce((n, p) => n + p.trackedProducts, 0),
      totalUnits: parts.reduce((n, p) => n + p.totalUnits, 0),
      valueAtCostCOP: parts.reduce((n, p) => n + p.stockValueAtCostCOP, 0),
      valueAtPriceCOP: parts.reduce((n, p) => n + p.stockValueAtPriceCOP, 0),
      lowStock,
      lowStockCount: lowStock.length,
      outOfStockCount: lowStock.filter((p) => p.stock <= 0).length,
    };
  }

  /** Saldos pendientes actuales de un negocio, no vencimientos del día. */
  async pendingPayment(
    actor: AuthenticatedUser,
    business: BusinessRef,
  ): Promise<PendingPaymentAnswer> {
    const ctx = await this.scope.contextFor(actor, business.id);
    this.scope.assertPermission(ctx, 'retail:sales:read');
    const debt = await this.retailSales.pendingPaymentByCustomer(ctx);
    return { business, ...debt };
  }

  /** Consulta de ámbito plataforma: exige `isPlatformAdmin`, como `/platform/*`. */
  async platformOverview(
    actor: AuthenticatedUser,
  ): Promise<PlatformOverviewAnswer> {
    if (!actor.isPlatformAdmin) {
      throw new ForbiddenException('Platform admin privileges required');
    }
    const overview = await this.platform.getOverview();
    const tenants = overview.tenants.byStatus;
    const subs = overview.subscriptions.byStatus;
    const count = (source: Record<string, number>, key: string) =>
      source[key] ?? 0;

    return {
      tenants: {
        total: overview.tenants.total,
        active: count(tenants, 'ACTIVE'),
        suspended: count(tenants, 'SUSPENDED'),
      },
      subscriptions: {
        active: count(subs, 'ACTIVE'),
        trialing: count(subs, 'TRIALING'),
        pastDue: count(subs, 'PAST_DUE'),
        billable:
          count(subs, 'ACTIVE') +
          count(subs, 'TRIALING') +
          count(subs, 'PAST_DUE'),
      },
      mrrCOP: overview.subscriptions.mrrCOP,
      payments: {
        month: overview.payments.month,
        count: overview.payments.count,
        totalCOP: overview.payments.totalAmount,
      },
    };
  }
}
