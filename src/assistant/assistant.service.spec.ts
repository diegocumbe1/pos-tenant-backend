import { ForbiddenException } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/types/tenant-context.interface';
import { PlatformService } from '../platform/platform.service';
import { RetailInventoryService } from '../retail/modules/inventory/retail-inventory.service';
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
  };
  let retailInventory: { getSummary: jest.Mock };
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
    );
  });

  describe('salesToday', () => {
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
      const answer = await service.salesToday(admin, business);
      expect(answer.revenueCOP).toBe(400);
      expect(answer.salesCount).toBe(4);
      expect(answer.averageTicketCOP).toBe(100);
      // 160 de utilidad sobre 400 de venta, no el promedio de 50% y 10%.
      expect(answer.marginPct).toBe(40);
    });

    it('asks each branch for today in local time', async () => {
      await service.salesToday(admin, business);
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
      const answer = await service.salesToday(admin, business);
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
