import { RetailProduct } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import { RetailCatalogService } from '../catalog/retail-catalog.service';
import { RetailInventoryService } from './retail-inventory.service';

const helper = {
  assertRetailTenant: jest.fn().mockResolvedValue(undefined),
} as unknown as RetailTenantHelper;
const base = {
  id: 'active',
  name: 'Active',
  sku: null,
  isActive: true,
  isPublished: false,
  trackStock: true,
  stock: 0,
  minStock: 3,
  costCOP: 100,
  avgCostCOP: 100,
  priceCOP: 200,
};
it('excludes drafts from summary alerts without losing their physical inventory valuation', async () => {
  const findMany = jest
    .fn()
    .mockResolvedValue([
      base,
      { ...base, id: 'draft-empty', isActive: false },
      { ...base, id: 'draft-stocked', isActive: false, stock: 2 },
      { ...base, id: 'at-minimum', stock: 3 },
      { ...base, id: 'healthy', stock: 10 },
    ]);
  const service = new RetailInventoryService(
    { retailProduct: { findMany } } as unknown as PrismaService,
    helper,
  );
  const result = await service.getSummary({
    tenantId: 'tenant',
    branchId: 'branch',
  } as TenantContext);
  expect(result.lowStockCount).toBe(2);
  expect(result.lowStock.map((p) => p.id)).toEqual(['active', 'at-minimum']);
  expect(result.totalUnits).toBe(15);
  expect(result.stockValueAtCostCOP).toBe(1500);
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        tenantId: 'tenant',
        branchId: 'branch',
        deletedAt: null,
        trackStock: true,
      },
      select: expect.objectContaining({ isActive: true }) as unknown,
    }),
  );
});
it('excludes draft variants and keeps active unpublished products eligible', () => {
  const service = new RetailCatalogService({} as PrismaService, helper);
  const product = {
    ...base,
    stockOptionIds: ['size'],
    options: [],
    imageUrls: [],
    videoUrls: [],
    variants: [
      {
        id: 'variant',
        stock: 0,
        minStock: 1,
        optionValueIds: ['small'],
        label: 'Small',
      },
    ],
  } as unknown as RetailProduct;
  const active = service['toProductDto'](product, 0, true);
  expect(active.isLowStock).toBe(true);
  expect(active.hasLowStockVariant).toBe(true);
  expect(active.variants[0].isLowStock).toBe(true);
  const draft = service['toProductDto'](
    { ...product, isActive: false },
    0,
    true,
  );
  expect(draft.isLowStock).toBe(false);
  expect(draft.hasLowStockVariant).toBe(false);
  expect(draft.variants[0].isLowStock).toBe(false);
});
