import { ForbiddenException } from '@nestjs/common';
import { SalesService } from './sales.service';

const build = () => {
  const prisma = { order: { findMany: jest.fn().mockResolvedValue([]) } };
  const service = new SalesService(prisma as never, { record: jest.fn() } as never);
  return { service, prisma };
};
const ctx = (roleCode: string, isRoot = false) =>
  ({ tenantId: 't1', branchId: 'b1', roleCode, isRoot }) as never;

describe('SalesService.waiterRanking — solo el dueño', () => {
  it.each(['MANAGER', 'WAITER', 'CASHIER', 'KITCHEN'])('%s recibe 403 y no consulta nada', async (role) => {
    const { service, prisma } = build();
    await expect(service.waiterRanking(ctx(role))).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it('el dueño sí lo ve, solo de su sede y de ventas cerradas', async () => {
    const { service, prisma } = build();
    const r = await service.waiterRanking(ctx('OWNER'), '2026-11-01', '2026-11-30');
    expect(r).toEqual({ rows: [], ordersCount: 0, ordersWithoutRecord: 0 });
    expect(prisma.order.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 't1', branchId: 'b1', status: 'CLOSED',
    });
  });
});
