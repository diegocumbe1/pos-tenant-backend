import { PrismaService } from '../prisma/prisma.service';

/** Read-only platform overview. Every query is scoped to the requested tenant. */
export async function tenantVerticalOperations(db: PrismaService, tenantId: string, vertical: string) {
  if (vertical === 'retail') {
    const where = { tenantId, deletedAt: null };
    const [catalog, active, customers, transactions, pending, stock, products, activity, byBranch, salesByBranch] = await Promise.all([
      db.retailProduct.count({ where }),
      db.retailProduct.count({ where: { ...where, isActive: true } }),
      db.retailCustomer.count({ where: { tenantId } }),
      db.retailSale.count({ where: { tenantId } }),
      db.retailSale.count({ where: { tenantId, status: 'COMPLETED', paymentStatus: { not: 'PAID' } } }),
      db.retailProduct.aggregate({ where: { ...where, trackStock: true }, _sum: { stock: true } }),
      db.retailProduct.findMany({ where, select: { id: true, branchId: true, name: true, priceCOP: true, isActive: true, stock: true, trackStock: true }, orderBy: { name: 'asc' }, take: 50 }),
      db.retailSale.findMany({ where: { tenantId }, select: { id: true, branchId: true, code: true, totalCOP: true, status: true, soldAt: true, paymentStatus: true }, orderBy: [{ soldAt: 'desc' }, { id: 'desc' }], take: 25 }),
      db.retailProduct.groupBy({ by: ['branchId'], where, _count: { _all: true } }),
      db.retailSale.groupBy({ by: ['branchId'], where: { tenantId }, _count: { _all: true } }),
    ]);
    return {
      kind: 'retail' as const,
      counts: { catalog, active, customers, transactions, pending, stockUnits: stock._sum.stock ?? 0 },
      branches: byBranch.map(b => ({ id: b.branchId, catalog: b._count._all })),
      branchActivity: salesByBranch.map(b => ({ id: b.branchId, count: b._count._all })),
      catalog: products.map(p => ({ ...p, stock: p.trackStock ? p.stock : null })),
      activity: activity.map(s => ({ id: s.id, branchId: s.branchId, name: s.code, status: s.status, detail: s.paymentStatus, amountCOP: s.totalCOP, date: s.soldAt.toISOString() })),
    };
  }
  if (vertical === 'barber') {
    const where = { tenantId };
    const [catalog, active, customers, transactions, pending, staff, services, activity, byBranch, appointmentsByBranch] = await Promise.all([
      db.barberService.count({ where }),
      db.barberService.count({ where: { ...where, isActive: true } }),
      db.barberCustomer.count({ where }),
      db.barberAppointment.count({ where }),
      db.barberAppointment.count({ where: { ...where, scheduledAt: { gte: new Date() }, status: { notIn: ['CANCELLED', 'COMPLETED', 'NO_SHOW'] } } }),
      db.barberStaff.count({ where: { ...where, isActive: true } }),
      db.barberService.findMany({ where, select: { id: true, branchId: true, name: true, priceCOP: true, isActive: true, durationMin: true }, orderBy: { name: 'asc' }, take: 50 }),
      db.barberAppointment.findMany({ where, select: { id: true, branchId: true, status: true, scheduledAt: true, priceCOP: true, service: { select: { name: true } }, staff: { select: { name: true } } }, orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }], take: 25 }),
      db.barberService.groupBy({ by: ['branchId'], where, _count: { _all: true } }),
      db.barberAppointment.groupBy({ by: ['branchId'], where, _count: { _all: true } }),
    ]);
    return {
      kind: 'barber' as const,
      counts: { catalog, active, customers, transactions, pending, staff },
      branches: byBranch.map(b => ({ id: b.branchId, catalog: b._count._all })),
      branchActivity: appointmentsByBranch.map(b => ({ id: b.branchId, count: b._count._all })),
      catalog: services,
      activity: activity.map(a => ({ id: a.id, branchId: a.branchId, name: a.service.name, status: a.status, detail: a.staff?.name ?? 'Sin profesional', amountCOP: a.priceCOP, date: a.scheduledAt.toISOString() })),
    };
  }
  return undefined;
}
