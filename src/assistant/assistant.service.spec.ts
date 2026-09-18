import { ForbiddenException } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/types/tenant-context.interface';
import { PlatformService } from '../platform/platform.service';
import { RetailSalesService } from '../retail/modules/sales/retail-sales.service';
import { AssistantScopeService } from './assistant-scope.service';
import { AssistantService } from './assistant.service';

describe('AssistantService', () => {
  let service: AssistantService;
  let platform: { getOverview: jest.Mock };
  let scope: { contextFor: jest.Mock; assertPermission: jest.Mock };
  let retailSales: { pendingPaymentByCustomer: jest.Mock };
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
    };
    retailSales = {
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
    );
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
