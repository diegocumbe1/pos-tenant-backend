import { ForbiddenException } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/types/tenant-context.interface';
import { PlatformService } from '../platform/platform.service';
import { RetailCatalogService } from '../retail/modules/catalog/retail-catalog.service';
import { RetailInventoryService } from '../retail/modules/inventory/retail-inventory.service';
import { RetailPurchasesService } from '../retail/modules/purchases/retail-purchases.service';
import { RetailSalesService } from '../retail/modules/sales/retail-sales.service';
import { AssistantScopeService } from './assistant-scope.service';
import { AssistantService } from './assistant.service';

describe('AssistantService', () => {
  let service: AssistantService;
  let platform: { getOverview: jest.Mock };
  let scope: {
    contextFor: jest.Mock;
    assertPermission: jest.Mock;
    branchesOf: jest.Mock;
  };
  let retailSales: {
    pendingPaymentByCustomer: jest.Mock;
    getSummary: jest.Mock;
    listSales: jest.Mock;
    salesRanking: jest.Mock;
  };
  let retailInventory: { getSummary: jest.Mock };
  let retailPurchases: { getSummary: jest.Mock };
  let retailCatalog: { listProducts: jest.Mock };
  const admin = { id: 'u1', isPlatformAdmin: true } as AuthenticatedUser;
  const cashier = { id: 'u2', isPlatformAdmin: false } as AuthenticatedUser;

  beforeEach(() => {
    platform = {
      getOverview: jest.fn().mockResolvedValue({
        tenants: { total: 4, byStatus: { ACTIVE: 3, SUSPENDED: 1 } },
        subscriptions: {
          byStatus: { ACTIVE: 2, TRIALING: 1, CANCELED: 5 },
          mrrCOP: 450000,
          mrrUSD: 0,
        },
        payments: { month: '2026-09', count: 2, totalAmount: 300000 },
      }),
    };
    scope = {
      contextFor: jest.fn().mockResolvedValue({
        tenantId: 't1',
        isRoot: true,
        permissions: new Set(),
      }),
      assertPermission: jest.fn(),
      branchesOf: jest.fn().mockResolvedValue(['b1', 'b2']),
    };
    const shelf = [
      {
        name: 'Mantequilla corporal',
        priceCOP: 32000,
        stock: 12,
        trackStock: true,
        categoryId: 'c1',
        categoryName: 'Cuidado corporal',
        variants: [
          { label: 'Vainilla', stock: 4 },
          { label: 'Coco', stock: 3 },
        ],
      },
      {
        name: 'Exfoliante de café',
        priceCOP: 28000,
        stock: 5,
        trackStock: true,
        categoryId: 'c1',
        categoryName: 'Cuidado corporal',
        variants: [],
      },
      {
        name: 'Serum facial',
        priceCOP: 45000,
        stock: 2,
        trackStock: true,
        categoryId: 'c2',
        categoryName: 'Rostro',
        variants: [],
      },
    ];
    retailCatalog = { listProducts: jest.fn().mockResolvedValue(shelf) };
    retailPurchases = {
      getSummary: jest
        .fn()
        .mockResolvedValue({ openCount: 3, estimatedOpenCostCOP: 1000 }),
    };
    retailInventory = {
      getSummary: jest.fn().mockImplementation((ctx: { branchId: string }) =>
        Promise.resolve({
          trackedProducts: ctx.branchId === 'b1' ? 10 : 5,
          totalUnits: ctx.branchId === 'b1' ? 100 : 50,
          stockValueAtCostCOP: ctx.branchId === 'b1' ? 900 : 100,
          stockValueAtPriceCOP: ctx.branchId === 'b1' ? 1500 : 200,
          lowStockCount: 1,
          lowStock: [
            ctx.branchId === 'b1'
              ? { name: 'Rímel', stock: 3, minStock: 5, id: 'p1', sku: null }
              : { name: 'Base', stock: 0, minStock: 2, id: 'p2', sku: null },
          ],
        }),
      ),
    };
    retailSales = {
      getSummary: jest.fn(),
      listSales: jest.fn(),
      salesRanking: jest.fn(),
      pendingPaymentByCustomer: jest.fn().mockResolvedValue({
        totalCOP: 180000,
        salesCount: 3,
        customers: [{ name: 'Marcela Ruiz', amountCOP: 180000, salesCount: 3 }],
        unidentified: { amountCOP: 0, salesCount: 0 },
      }),
    };
    service = new AssistantService(
      platform as unknown as PlatformService,
      scope as unknown as AssistantScopeService,
      retailSales as unknown as RetailSalesService,
      retailInventory as unknown as RetailInventoryService,
      retailPurchases as unknown as RetailPurchasesService,
      retailCatalog as unknown as RetailCatalogService,
    );
  });

  describe('salesRanking', () => {
    const business = { id: 't1', name: 'Bella Chic' };

    beforeEach(() => {
      retailSales.salesRanking = jest.fn().mockResolvedValue({
        soldProductCount: 2,
        products: [
          { name: 'Mantequilla corporal', units: 30, revenueCOP: 960000 },
          { name: 'Serum facial', units: 2, revenueCOP: 90000 },
        ],
        variants: [{ label: 'Vainilla', units: 12 }],
        customers: [{ name: 'Marcela', salesCount: 4, totalCOP: 400000 }],
        counterSales: 3,
      });
    });

    it('cuenta lo que NO se vendió contra el catálogo', async () => {
      // El catálogo tiene 3 productos; se vendieron 2.
      const answer = await service.salesRanking(admin, business, 'month');
      expect(answer.unsoldCount).toBe(1);
    });

    it('nunca reporta un no-vendido negativo', async () => {
      retailCatalog.listProducts.mockResolvedValue([]);
      const answer = await service.salesRanking(admin, business, 'month');
      expect(answer.unsoldCount).toBe(0);
    });

    it('exige ventas y catálogo antes de consultar', async () => {
      await service.salesRanking(admin, business, 'month');
      const codes = (
        scope.assertPermission.mock.calls as [unknown, string][]
      ).map(([, code]) => code);
      expect(codes).toContain('retail:sales:read');
      expect(codes).toContain('retail:catalog:read');
    });
  });

  describe('catálogo', () => {
    const business = { id: 't1', name: 'Bella Chic' };

    it('cuenta productos por categoría y deja fuera las vacías', async () => {
      const answer = await service.catalogOverview(admin, business);
      // Dos sucursales con el mismo mock: los conteos se suman.
      expect(answer.productCount).toBe(3);
      expect(answer.categories).toEqual([
        { id: 'c1', name: 'Cuidado corporal', productCount: 2 },
        { id: 'c2', name: 'Rostro', productCount: 1 },
      ]);
    });

    it('encuentra la categoría aunque la digan a medias', async () => {
      const answer = await service.catalogCategory(admin, business, 'corporal');
      expect(answer.category?.name).toBe('Cuidado corporal');
      expect(answer.productCount).toBe(2);
      // De mayor a menor stock: lo que hay de verdad se nombra primero.
      expect(answer.products[0].name).toBe('Mantequilla corporal');
    });

    it('devuelve vacío cuando la categoría no existe', async () => {
      const answer = await service.catalogCategory(
        admin,
        business,
        'ferretería',
      );
      expect(answer.category).toBeNull();
      expect(answer.products).toEqual([]);
    });

    it('resuelve un producto por nombre exacto aunque otros lo contengan', async () => {
      const answer = await service.productLookup(
        admin,
        business,
        'mantequilla corporal',
      );
      expect(answer.product?.name).toBe('Mantequilla corporal');
      expect(answer.candidates).toEqual([]);
    });

    it('pide acotar en vez de elegir por su cuenta', async () => {
      retailCatalog.listProducts.mockResolvedValue([
        {
          name: 'Aceite de coco',
          priceCOP: 1,
          stock: 1,
          trackStock: true,
          categoryId: 'c1',
          categoryName: 'x',
          variants: [],
        },
        {
          name: 'Aceite de almendras',
          priceCOP: 1,
          stock: 1,
          trackStock: true,
          categoryId: 'c1',
          categoryName: 'x',
          variants: [],
        },
      ]);
      const answer = await service.productLookup(admin, business, 'aceite');
      expect(answer.product).toBeNull();
      expect(answer.matchCount).toBe(2);
      expect(answer.candidates).toContain('Aceite de coco');
    });

    it('avisa cuando no hay ninguna coincidencia', async () => {
      retailCatalog.listProducts.mockResolvedValue([]);
      const answer = await service.productLookup(admin, business, 'tornillos');
      expect(answer.matchCount).toBe(0);
      expect(answer.product).toBeNull();
    });

    it('exige el permiso de catálogo antes de consultar', async () => {
      scope.assertPermission.mockImplementation(() => {
        throw new ForbiddenException();
      });
      await expect(
        service.catalogOverview(admin, business),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(retailCatalog.listProducts).not.toHaveBeenCalled();
    });
  });

  describe('businessReport', () => {
    const business = { id: 't1', name: 'Bella Chic' };

    beforeEach(() => {
      retailSales.getSummary.mockResolvedValue({
        salesCount: 2,
        revenueCOP: 200,
        grossProfitCOP: 80,
        unitsSold: 4,
        pendingPayment: { amountCOP: 30, salesCount: 1 },
      });
      retailSales.listSales.mockResolvedValue([
        { totalCOP: 70, customerName: 'Marcela' },
      ]);
    });

    it('resolves branches once for the five blocks, not once each', async () => {
      await service.businessReport(admin, business, 'day');
      expect(scope.branchesOf).toHaveBeenCalledTimes(1);
      expect(scope.contextFor).toHaveBeenCalledTimes(1);
    });

    it('checks both permissions before any query', async () => {
      await service.businessReport(admin, business, 'day');
      const codes = (
        scope.assertPermission.mock.calls as [unknown, string][]
      ).map(([, code]) => code);
      expect(codes).toEqual(['retail:sales:read', 'retail:inventory:read']);
    });

    it('only the sales block moves with the period', async () => {
      const day = await service.businessReport(admin, business, 'day');
      const month = await service.businessReport(admin, business, 'month');
      // La cartera, el stock y los pendientes son una foto de hoy.
      expect(month.debt).toEqual(day.debt);
      expect(month.inventory).toEqual(day.inventory);
      expect(month.delivery).toEqual(day.delivery);
      expect(month.purchases).toEqual(day.purchases);
    });

    it('asks sales for a wider range on month than on day', async () => {
      const firstFrom = () =>
        (retailSales.getSummary.mock.calls as [unknown, string][])[0][1];
      await service.businessReport(admin, business, 'day');
      const dayFrom = firstFrom();
      retailSales.getSummary.mockClear();
      await service.businessReport(admin, business, 'month');
      const monthFrom = firstFrom();
      expect(new Date(monthFrom).getTime()).toBeLessThanOrEqual(
        new Date(dayFrom).getTime(),
      );
      expect(new Date(monthFrom).getDate()).toBe(1);
    });

    it('adds up open purchase orders across branches', async () => {
      const report = await service.businessReport(admin, business, 'day');
      expect(report.purchases).toEqual({
        openCount: 6,
        estimatedOpenCostCOP: 2000,
      });
    });
  });

  describe('sales', () => {
    const business = { id: 't1', name: 'Bella Chic' };

    beforeEach(() => {
      retailSales.getSummary = jest
        .fn()
        .mockImplementation((ctx: { branchId: string }) =>
          Promise.resolve(
            ctx.branchId === 'b1'
              ? {
                  salesCount: 3,
                  revenueCOP: 300,
                  grossProfitCOP: 150,
                  unitsSold: 6,
                  pendingPayment: { amountCOP: 50, salesCount: 1 },
                }
              : {
                  salesCount: 1,
                  revenueCOP: 100,
                  grossProfitCOP: 10,
                  unitsSold: 2,
                  pendingPayment: { amountCOP: 0, salesCount: 0 },
                },
          ),
        );
    });

    it('recomputes margin and average ticket instead of averaging averages', async () => {
      const answer = await service.sales(admin, business);
      expect(answer.revenueCOP).toBe(400);
      expect(answer.salesCount).toBe(4);
      expect(answer.averageTicketCOP).toBe(100);
      // 160 de utilidad sobre 400 de venta, no el promedio de 50% y 10%.
      expect(answer.marginPct).toBe(40);
    });

    it('leaves shipping out of revenue and ticket, like the sales screen', async () => {
      // `summary.revenueCOP` viene en base caja CON el flete adentro; por eso
      // `shippingCOP` viaja aparte. Si el asistente no lo restara, contestaría
      // un número distinto al de la pantalla a la misma pregunta.
      retailSales.getSummary.mockImplementation((ctx: { branchId: string }) =>
        Promise.resolve(
          ctx.branchId === 'b1'
            ? {
                salesCount: 3,
                revenueCOP: 300,
                shippingCOP: 20,
                grossProfitCOP: 150,
                unitsSold: 6,
                pendingPayment: { amountCOP: 50, salesCount: 1 },
              }
            : {
                salesCount: 1,
                revenueCOP: 100,
                shippingCOP: 0,
                grossProfitCOP: 10,
                unitsSold: 2,
                pendingPayment: { amountCOP: 0, salesCount: 0 },
              },
        ),
      );

      const answer = await service.sales(admin, business);
      // 400 entraron, 20 eran flete ⇒ 380 de mercancía.
      expect(answer.revenueCOP).toBe(380);
      expect(answer.shippingCOP).toBe(20);
      expect(answer.averageTicketCOP).toBe(95);
      // El margen se mide contra la misma base que el resumen del backend.
      expect(answer.marginPct).toBe(40);
    });

    it('treats a summary without shipping as zero, never NaN', async () => {
      const answer = await service.sales(admin, business);
      expect(Number.isNaN(answer.revenueCOP)).toBe(false);
      expect(answer.shippingCOP).toBe(0);
    });

    it('asks each branch for today in local time', async () => {
      await service.sales(admin, business);
      const [, from, to] = retailSales.getSummary.mock.calls[0] as [
        unknown,
        string,
        string,
      ];
      expect(new Date(from).getHours()).toBe(0);
      expect(new Date(to).getTime()).toBeGreaterThan(new Date(from).getTime());
    });

    it('reports zero without inventing a ticket', async () => {
      retailSales.getSummary.mockResolvedValue({
        salesCount: 0,
        revenueCOP: 0,
        grossProfitCOP: 0,
        unitsSold: 0,
        pendingPayment: { amountCOP: 0, salesCount: 0 },
      });
      const answer = await service.sales(admin, business);
      expect(answer.averageTicketCOP).toBe(0);
      expect(answer.marginPct).toBe(0);
    });
  });

  describe('pendingDelivery', () => {
    const business = { id: 't1', name: 'Bella Chic' };

    it('groups by customer across branches and keeps unnamed sales apart', async () => {
      retailSales.listSales = jest
        .fn()
        .mockImplementation((ctx: { branchId: string }) =>
          Promise.resolve(
            ctx.branchId === 'b1'
              ? [
                  { totalCOP: 100, customerName: 'Marcela' },
                  { totalCOP: 50, customerName: null },
                ]
              : [{ totalCOP: 200, customerName: 'Marcela' }],
          ),
        );
      const answer = await service.pendingDelivery(admin, business);
      expect(answer.salesCount).toBe(3);
      expect(answer.totalCOP).toBe(350);
      expect(answer.customers).toEqual([
        { name: 'Marcela', salesCount: 2, totalCOP: 300 },
        { name: 'Sin cliente registrado', salesCount: 1, totalCOP: 50 },
      ]);
    });
  });

  describe('inventoryStatus', () => {
    const business = { id: 't1', name: 'Bella Chic' };

    it('adds up every branch: a query per branch is the only way to reuse the rules', async () => {
      const answer = await service.inventoryStatus(admin, business);
      expect(scope.branchesOf).toHaveBeenCalledWith('t1');
      expect(retailInventory.getSummary).toHaveBeenCalledTimes(2);
      expect(answer.trackedProducts).toBe(15);
      expect(answer.totalUnits).toBe(150);
      expect(answer.valueAtCostCOP).toBe(1000);
    });

    it('sorts the low stock across branches and counts the sold out ones', async () => {
      const answer = await service.inventoryStatus(admin, business);
      expect(answer.lowStock.map((p) => p.name)).toEqual(['Base', 'Rímel']);
      expect(answer.outOfStockCount).toBe(1);
    });

    it('checks the inventory permission before querying', async () => {
      scope.assertPermission.mockImplementation(() => {
        throw new ForbiddenException();
      });
      await expect(
        service.inventoryStatus(admin, business),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(retailInventory.getSummary).not.toHaveBeenCalled();
    });
  });

  describe('pendingPayment', () => {
    const business = { id: 't1', name: 'Bella Chic' };

    it('checks the retail permission before querying', async () => {
      await service.pendingPayment(admin, business);
      expect(scope.assertPermission).toHaveBeenCalledWith(
        expect.anything(),
        'retail:sales:read',
      );
      expect(retailSales.pendingPaymentByCustomer).toHaveBeenCalled();
    });

    it('scopes the query to the requested business', async () => {
      await service.pendingPayment(admin, business);
      expect(scope.contextFor).toHaveBeenCalledWith(admin, 't1');
    });

    it('does not query when the permission check throws', async () => {
      scope.assertPermission.mockImplementation(() => {
        throw new ForbiddenException();
      });
      await expect(
        service.pendingPayment(admin, business),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(retailSales.pendingPaymentByCustomer).not.toHaveBeenCalled();
    });
  });

  it('reads the figures from the platform service, never from constants', async () => {
    const answer = await service.platformOverview(admin);
    expect(platform.getOverview).toHaveBeenCalledTimes(1);
    expect(answer).toEqual({
      tenants: { total: 4, active: 3, suspended: 1 },
      subscriptions: { active: 2, trialing: 1, pastDue: 0, billable: 3 },
      mrrCOP: 450000,
      payments: { month: '2026-09', count: 2, totalCOP: 300000 },
    });
  });

  it('treats a status absent from the grouping as zero', async () => {
    platform.getOverview.mockResolvedValue({
      tenants: { total: 0, byStatus: {} },
      subscriptions: { byStatus: {}, mrrCOP: 0, mrrUSD: 0 },
      payments: { month: '2026-09', count: 0, totalAmount: 0 },
    });
    const answer = await service.platformOverview(admin);
    expect(answer.subscriptions).toEqual({
      active: 0,
      trialing: 0,
      pastDue: 0,
      billable: 0,
    });
  });

  it('refuses a non platform admin before touching the database', async () => {
    await expect(service.platformOverview(cashier)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(platform.getOverview).not.toHaveBeenCalled();
  });
});
