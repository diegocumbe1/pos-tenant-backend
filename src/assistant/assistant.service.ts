import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  AuthenticatedUser,
  TenantContext,
} from '../auth/types/tenant-context.interface';
import { PlatformService } from '../platform/platform.service';
import { RetailCatalogService } from '../retail/modules/catalog/retail-catalog.service';
import { RetailInventoryService } from '../retail/modules/inventory/retail-inventory.service';
import { RetailPurchasesService } from '../retail/modules/purchases/retail-purchases.service';
import { RetailSalesService } from '../retail/modules/sales/retail-sales.service';
import { AssistantScopeService, BusinessRef } from './assistant-scope.service';
import {
  BusinessReportAnswer,
  CatalogCategoryAnswer,
  CatalogOverviewAnswer,
  DebtFigures,
  DeliveryFigures,
  InventoryFigures,
  InventoryStatusAnswer,
  PendingDeliveryAnswer,
  PendingPaymentAnswer,
  PlatformOverviewAnswer,
  ProductLookupAnswer,
  PurchaseFigures,
  ReportPeriod,
  SalesAnswer,
  SalesFigures,
  SalesRankingAnswer,
} from './assistant.types';
import { periodRange } from './report-period';

const SALES_READ = 'retail:sales:read';
const INVENTORY_READ = 'retail:inventory:read';
const CATALOG_READ = 'retail:catalog:read';

/** Alexa transcribe distinto cada vez: se compara sin tildes ni puntuación. */
function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Contexto y sucursales del negocio, resueltos una sola vez por consulta. */
interface Scope {
  ctx: TenantContext;
  branchIds: string[];
}

/**
 * Capacidad de consulta compartida entre canales (Alexa, chat web).
 *
 * Responsabilidades: verificar permisos del actor y devolver cifras. La
 * redacción —hablada o en pantalla— es del canal, no de aquí.
 *
 * Casi todo retail filtra por `ctx.branchId`, así que las consultas de negocio
 * completo corren una vez por sucursal y se suman. Ver `AssistantScopeService`.
 */
@Injectable()
export class AssistantService {
  constructor(
    private readonly platform: PlatformService,
    private readonly scope: AssistantScopeService,
    private readonly retailSales: RetailSalesService,
    private readonly retailInventory: RetailInventoryService,
    private readonly retailPurchases: RetailPurchasesService,
    private readonly retailCatalog: RetailCatalogService,
  ) {}

  private async open(
    actor: AuthenticatedUser,
    business: BusinessRef,
    permissions: string[],
  ): Promise<Scope> {
    const ctx = await this.scope.contextFor(actor, business.id);
    for (const code of permissions) this.scope.assertPermission(ctx, code);
    return { ctx, branchIds: await this.scope.branchesOf(business.id) };
  }

  /**
   * Los cinco bloques del reporte, en una sola tanda de consultas.
   *
   * Van juntas en un `Promise.all` porque son cinco por sucursal: en serie, la
   * latencia a Supabase se sentiría en la respuesta hablada.
   */
  async businessReport(
    actor: AuthenticatedUser,
    business: BusinessRef,
    period: ReportPeriod,
  ): Promise<BusinessReportAnswer> {
    const scope = await this.open(actor, business, [
      SALES_READ,
      INVENTORY_READ,
    ]);
    const [sales, debt, inventory, purchases, delivery] = await Promise.all([
      this.salesFigures(scope, period),
      this.debtFigures(scope),
      this.inventoryFigures(scope),
      this.purchaseFigures(scope),
      this.deliveryFigures(scope),
    ]);
    return { business, period, sales, debt, inventory, purchases, delivery };
  }

  async sales(
    actor: AuthenticatedUser,
    business: BusinessRef,
    period: ReportPeriod = 'day',
  ): Promise<SalesAnswer> {
    const scope = await this.open(actor, business, [SALES_READ]);
    return {
      business,
      period,
      ...(await this.salesFigures(scope, period)),
    };
  }

  /** Saldos pendientes actuales de un negocio, no vencimientos del día. */
  async pendingPayment(
    actor: AuthenticatedUser,
    business: BusinessRef,
  ): Promise<PendingPaymentAnswer> {
    const scope = await this.open(actor, business, [SALES_READ]);
    return { business, ...(await this.debtFigures(scope)) };
  }

  async inventoryStatus(
    actor: AuthenticatedUser,
    business: BusinessRef,
  ): Promise<InventoryStatusAnswer> {
    const scope = await this.open(actor, business, [INVENTORY_READ]);
    return { business, ...(await this.inventoryFigures(scope)) };
  }

  async pendingDelivery(
    actor: AuthenticatedUser,
    business: BusinessRef,
  ): Promise<PendingDeliveryAnswer> {
    const scope = await this.open(actor, business, [SALES_READ]);
    return { business, ...(await this.deliveryFigures(scope)) };
  }

  /**
   * Rankings del período: productos, presentaciones y clientes.
   *
   * Se compone con el catálogo para poder decir cuántos productos NO se
   * vendieron. Preguntar "¿cuál es el menos vendido?" casi siempre quiere decir
   * "¿qué está quieto?", y el que vendió dos unidades no es esa respuesta.
   */
  async salesRanking(
    actor: AuthenticatedUser,
    business: BusinessRef,
    period: ReportPeriod,
  ): Promise<SalesRankingAnswer> {
    const { ctx } = await this.open(actor, business, [
      SALES_READ,
      CATALOG_READ,
    ]);
    const { from, to } = periodRange(period);
    const [ranking, catalog] = await Promise.all([
      this.retailSales.salesRanking(ctx, from.toISOString(), to.toISOString()),
      this.mergedProducts(actor, business),
    ]);

    return {
      business,
      period,
      products: ranking.products,
      variants: ranking.variants,
      customers: ranking.customers,
      unsoldCount: Math.max(0, catalog.length - ranking.soldProductCount),
      counterSales: ranking.counterSales,
    };
  }

  // ─── Catálogo ─────────────────────────────────────────────────────────────

  async catalogOverview(
    actor: AuthenticatedUser,
    business: BusinessRef,
  ): Promise<CatalogOverviewAnswer> {
    const products = await this.mergedProducts(actor, business);

    const counts = new Map<string, { name: string; productCount: number }>();
    for (const product of products) {
      if (!product.categoryId) continue;
      const entry = counts.get(product.categoryId) ?? {
        name: product.categoryName,
        productCount: 0,
      };
      entry.productCount += 1;
      counts.set(product.categoryId, entry);
    }

    return {
      business,
      productCount: products.length,
      // Solo las que tienen productos: nombrar categorías vacías hace perder
      // un turno de conversación para nada.
      categories: [...counts.entries()]
        .map(([id, value]) => ({ id, ...value }))
        .sort((a, b) => b.productCount - a.productCount),
    };
  }

  async catalogCategory(
    actor: AuthenticatedUser,
    business: BusinessRef,
    spokenCategory: string,
  ): Promise<CatalogCategoryAnswer> {
    const products = await this.mergedProducts(actor, business);
    const said = normalizeName(spokenCategory);
    const matches = products.filter((product) => {
      const name = normalizeName(product.categoryName);
      return name === said || name.includes(said) || said.includes(name);
    });
    if (!matches.length) {
      return { business, category: null, productCount: 0, products: [] };
    }

    return {
      business,
      category: { id: matches[0].categoryId, name: matches[0].categoryName },
      productCount: matches.length,
      products: matches
        .sort((a, b) => b.stock - a.stock)
        .map((p) => ({ name: p.name, priceCOP: p.priceCOP, stock: p.stock })),
    };
  }

  /**
   * Un producto concreto.
   *
   * `listProducts({ search })` ya busca por nombre, sku, código de barras y
   * marca, así que no hay que reimplementar la búsqueda. Lo que se decide acá
   * es qué hacer con varios resultados: por voz, leer diez es inútil, y elegir
   * el primero sería adivinar.
   */
  async productLookup(
    actor: AuthenticatedUser,
    business: BusinessRef,
    spokenProduct: string,
  ): Promise<ProductLookupAnswer> {
    const matches = await this.mergedProducts(actor, business, spokenProduct);
    if (!matches.length) {
      return { business, matchCount: 0, product: null, candidates: [] };
    }

    // Un nombre exacto gana: "mantequilla corporal" no debe quedar ambiguo solo
    // porque existan diez productos cuyo nombre lo contiene.
    const said = normalizeName(spokenProduct);
    const exact = matches.filter((p) => normalizeName(p.name) === said);
    const chosen =
      exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;

    if (!chosen) {
      return {
        business,
        matchCount: matches.length,
        product: null,
        candidates: matches.map((p) => p.name),
      };
    }
    return {
      business,
      matchCount: matches.length,
      product: {
        name: chosen.name,
        priceCOP: chosen.priceCOP,
        stock: chosen.stock,
        trackStock: chosen.trackStock,
        categoryName: chosen.categoryName,
        variants: chosen.variants,
      },
      candidates: [],
    };
  }

  /**
   * Productos del negocio, con las sucursales fundidas por nombre.
   *
   * Cada sucursal tiene sus PROPIAS filas de producto, así que sin esto "¿qué
   * productos tienes?" contaría la mantequilla dos veces y "¿cuántas quedan?"
   * quedaría ambiguo entre dos filas del mismo nombre. Quien pregunta por voz
   * quiere el número del negocio, no el de una bodega.
   */
  private async mergedProducts(
    actor: AuthenticatedUser,
    business: BusinessRef,
    search?: string,
  ) {
    const { ctx, branchIds } = await this.open(actor, business, [CATALOG_READ]);
    const perBranch = await Promise.all(
      branchIds.map((branchId) =>
        this.retailCatalog.listProducts(
          { ...ctx, branchId },
          search ? { search } : {},
        ),
      ),
    );

    const merged = new Map<
      string,
      {
        name: string;
        categoryId: string;
        categoryName: string;
        priceCOP: number;
        stock: number;
        trackStock: boolean;
        variants: { label: string; stock: number }[];
      }
    >();
    for (const product of perBranch.flat()) {
      const key = normalizeName(product.name);
      const entry = merged.get(key);
      if (!entry) {
        merged.set(key, {
          name: product.name,
          categoryId: product.categoryId,
          categoryName: product.categoryName ?? 'Sin categoría',
          priceCOP: product.priceCOP,
          stock: product.stock,
          trackStock: product.trackStock,
          variants: (product.variants ?? []).map((v) => ({
            label: v.label,
            stock: v.stock,
          })),
        });
        continue;
      }
      // El stock suma; el precio no; si difiere entre sucursales, manda el de
      // la primera y decirlo por voz sería ruido.
      entry.stock += product.stock;
      for (const variant of product.variants ?? []) {
        const same = entry.variants.find((v) => v.label === variant.label);
        if (same) same.stock += variant.stock;
        else
          entry.variants.push({ label: variant.label, stock: variant.stock });
      }
    }
    return [...merged.values()];
  }

  // ─── Bloques ──────────────────────────────────────────────────────────────

  /**
   * Al sumar sucursales, los totales se suman pero el margen y el ticket
   * promedio se RECALCULAN: promediar promedios daría un número que no
   * corresponde a ninguna venta real.
   */
  private async salesFigures(
    { ctx, branchIds }: Scope,
    period: ReportPeriod,
  ): Promise<SalesFigures> {
    const { from, to } = periodRange(period);
    const parts = await Promise.all(
      branchIds.map((branchId) =>
        this.retailSales.getSummary(
          { ...ctx, branchId },
          from.toISOString(),
          to.toISOString(),
        ),
      ),
    );

    const sum = (pick: (p: (typeof parts)[number]) => number) =>
      parts.reduce((n, p) => n + pick(p), 0);
    const revenueCOP = sum((p) => p.revenueCOP);
    const grossProfitCOP = sum((p) => p.grossProfitCOP);
    const salesCount = sum((p) => p.salesCount);

    return {
      salesCount,
      revenueCOP,
      unitsSold: sum((p) => p.unitsSold),
      averageTicketCOP: salesCount ? Math.round(revenueCOP / salesCount) : 0,
      marginPct: revenueCOP
        ? Math.round((grossProfitCOP / revenueCOP) * 1000) / 10
        : 0,
      creditedCOP: sum((p) => p.pendingPayment.amountCOP),
    };
  }

  /** Sin rango: la venta fiada de marzo se sigue debiendo en septiembre. */
  private debtFigures({ ctx }: Scope): Promise<DebtFigures> {
    return this.retailSales.pendingPaymentByCustomer(ctx);
  }

  private async inventoryFigures({
    ctx,
    branchIds,
  }: Scope): Promise<InventoryFigures> {
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
      trackedProducts: parts.reduce((n, p) => n + p.trackedProducts, 0),
      totalUnits: parts.reduce((n, p) => n + p.totalUnits, 0),
      valueAtCostCOP: parts.reduce((n, p) => n + p.stockValueAtCostCOP, 0),
      valueAtPriceCOP: parts.reduce((n, p) => n + p.stockValueAtPriceCOP, 0),
      lowStock,
      lowStockCount: lowStock.length,
      outOfStockCount: lowStock.filter((p) => p.stock <= 0).length,
    };
  }

  private async purchaseFigures({
    ctx,
    branchIds,
  }: Scope): Promise<PurchaseFigures> {
    const parts = await Promise.all(
      branchIds.map((branchId) =>
        this.retailPurchases.getSummary({ ...ctx, branchId }),
      ),
    );
    return {
      openCount: parts.reduce((n, p) => n + p.openCount, 0),
      estimatedOpenCostCOP: parts.reduce(
        (n, p) => n + p.estimatedOpenCostCOP,
        0,
      ),
    };
  }

  private async deliveryFigures({
    ctx,
    branchIds,
  }: Scope): Promise<DeliveryFigures> {
    const perBranch = await Promise.all(
      branchIds.map((branchId) =>
        this.retailSales.listSales(
          { ...ctx, branchId },
          { deliveryStatus: 'PENDING', limit: 500 },
        ),
      ),
    );

    const byCustomer = new Map<string, DeliveryFigures['customers'][0]>();
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
      salesCount,
      totalCOP,
      customers: [...byCustomer.values()].sort(
        (a, b) => b.totalCOP - a.totalCOP,
      ),
    };
  }

  // ─── Plataforma ───────────────────────────────────────────────────────────

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
