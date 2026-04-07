import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting seed...');

  // ─── Tenants ────────────────────────────────────────────────────────────────
  await prisma.tenant.upsert({
    where: { id: 'tenant-001' },
    update: {},
    create: { id: 'tenant-001', name: 'OriWok', plan: 'PRO' },
  });
  await prisma.tenant.upsert({
    where: { id: 'tenant-002' },
    update: {},
    create: { id: 'tenant-002', name: 'La Parrilla', plan: 'BASIC' },
  });
  await prisma.tenant.upsert({
    where: { id: 'tenant-barber-001' },
    update: {},
    create: { id: 'tenant-barber-001', name: 'Tijeras y Arte', plan: 'PRO' },
  });
  console.log('✅ Tenants');

  // ─── Branches ───────────────────────────────────────────────────────────────
  await prisma.branch.upsert({
    where: { id: 'branch-001' },
    update: {},
    create: {
      id: 'branch-001',
      tenantId: 'tenant-001',
      name: 'Sede Norte',
      address: 'Bogotá Norte',
    },
  });
  await prisma.branch.upsert({
    where: { id: 'branch-002' },
    update: {},
    create: {
      id: 'branch-002',
      tenantId: 'tenant-001',
      name: 'Sede Centro',
      address: 'Bogotá Centro',
    },
  });
  await prisma.branch.upsert({
    where: { id: 'branch-003' },
    update: {},
    create: {
      id: 'branch-003',
      tenantId: 'tenant-002',
      name: 'Sucursal Principal',
      address: 'Bogotá',
    },
  });
  await prisma.branch.upsert({
    where: { id: 'branch-barber-001' },
    update: {},
    create: {
      id: 'branch-barber-001',
      tenantId: 'tenant-barber-001',
      name: 'Sede Principal',
      address: 'Bogotá',
    },
  });
  console.log('✅ Branches');

  // ─── Users ──────────────────────────────────────────────────────────────────
  const users = [
    { id: 'user-001', tenantId: 'tenant-001', email: 'carlos@oriwok.com', name: 'Carlos', role: 'OWNER' },
    { id: 'user-002', tenantId: 'tenant-001', email: 'ana@oriwok.com', name: 'Ana', role: 'MANAGER' },
    { id: 'user-003', tenantId: 'tenant-001', email: 'pedro@oriwok.com', name: 'Pedro', role: 'WAITER' },
    { id: 'user-004', tenantId: 'tenant-001', email: 'luisa@oriwok.com', name: 'Luisa', role: 'KITCHEN' },
    { id: 'user-005', tenantId: 'tenant-001', email: 'sofia@oriwok.com', name: 'Sofía', role: 'CASHIER' },
  ];
  for (const user of users) {
    await prisma.user.upsert({ where: { id: user.id }, update: {}, create: user });
  }
  console.log('✅ Users');

  // ─── Product Categories ──────────────────────────────────────────────────────
  const categories = [
    { id: 'cat-001', tenantId: 'tenant-001', name: 'Entradas', emoji: '🥗', sortOrder: 1 },
    { id: 'cat-002', tenantId: 'tenant-001', name: 'Platos', emoji: '🍽️', sortOrder: 2 },
    { id: 'cat-003', tenantId: 'tenant-001', name: 'Bebidas', emoji: '🥤', sortOrder: 3 },
    { id: 'cat-004', tenantId: 'tenant-001', name: 'Postres', emoji: '🍮', sortOrder: 4 },
  ];
  for (const cat of categories) {
    await prisma.productCategory.upsert({ where: { id: cat.id }, update: {}, create: cat });
  }
  console.log('✅ Categories');

  // ─── Products ───────────────────────────────────────────────────────────────
  const products = [
    { id: 'm1', tenantId: 'tenant-001', categoryId: 'cat-001', name: 'Empanadas x3', description: 'Rellenas de carne molida', priceCOP: 12000, emoji: '🥟', isAvailable: true, sortOrder: 1 },
    { id: 'm2', tenantId: 'tenant-001', categoryId: 'cat-001', name: 'Patacones', priceCOP: 10000, emoji: '🫓', isAvailable: true, sortOrder: 2 },
    { id: 'm3', tenantId: 'tenant-001', categoryId: 'cat-001', name: 'Ceviche', priceCOP: 18000, emoji: '🍤', isAvailable: true, sortOrder: 3 },
    { id: 'm4', tenantId: 'tenant-001', categoryId: 'cat-001', name: 'Yuca frita', priceCOP: 9000, emoji: '🍟', isAvailable: true, sortOrder: 4 },
    { id: 'm5', tenantId: 'tenant-001', categoryId: 'cat-002', name: 'Bandeja Paisa', description: 'Plato típico colombiano completo', priceCOP: 28000, emoji: '🍛', isAvailable: true, sortOrder: 1 },
    { id: 'm6', tenantId: 'tenant-001', categoryId: 'cat-002', name: 'Ajiaco', priceCOP: 22000, emoji: '🥘', isAvailable: true, sortOrder: 2 },
    { id: 'm7', tenantId: 'tenant-001', categoryId: 'cat-002', name: 'Churrasco', priceCOP: 35000, emoji: '🥩', isAvailable: true, sortOrder: 3 },
    { id: 'm8', tenantId: 'tenant-001', categoryId: 'cat-002', name: 'Pollo al limón', priceCOP: 26000, emoji: '🍗', isAvailable: false, sortOrder: 4 },
    { id: 'm9', tenantId: 'tenant-001', categoryId: 'cat-003', name: 'Limonada', priceCOP: 8000, emoji: '🍋', isAvailable: true, sortOrder: 1 },
    { id: 'm10', tenantId: 'tenant-001', categoryId: 'cat-003', name: 'Jugo Natural', priceCOP: 9000, emoji: '🧃', isAvailable: true, sortOrder: 2 },
    { id: 'm11', tenantId: 'tenant-001', categoryId: 'cat-003', name: 'Gaseosa', priceCOP: 5000, emoji: '🥤', isAvailable: true, sortOrder: 3 },
    { id: 'm12', tenantId: 'tenant-001', categoryId: 'cat-003', name: 'Agua', priceCOP: 4000, emoji: '💧', isAvailable: true, sortOrder: 4 },
    { id: 'm13', tenantId: 'tenant-001', categoryId: 'cat-004', name: 'Tres Leches', priceCOP: 14000, emoji: '🍰', isAvailable: true, sortOrder: 1 },
    { id: 'm14', tenantId: 'tenant-001', categoryId: 'cat-004', name: 'Natilla', priceCOP: 12000, emoji: '🍮', isAvailable: true, sortOrder: 2 },
  ];
  for (const product of products) {
    await prisma.product.upsert({
      where: { id: product.id },
      update: {},
      create: { ...product, imageUrls: [] },
    });
  }
  console.log('✅ Products');

  // ─── Areas ──────────────────────────────────────────────────────────────────
  const areas = [
    { id: 'area-main',     tenantId: 'tenant-001', branchId: 'branch-001', name: 'Main Hall', emoji: '🍽️' },
    { id: 'area-terraza',  tenantId: 'tenant-001', branchId: 'branch-001', name: 'Terraza',   emoji: '🌿' },
    { id: 'area-bar',      tenantId: 'tenant-001', branchId: 'branch-001', name: 'Bar',       emoji: '🍹' },
  ];
  for (const area of areas) {
    await prisma.area.upsert({ where: { id: area.id }, update: {}, create: area });
  }
  console.log('✅ Areas');

  // ─── Restaurant Tables ───────────────────────────────────────────────────────
  const tables = [
    { id: 't1', tenantId: 'tenant-001', branchId: 'branch-001', areaId: 'area-main',    code: 'T-01', seats: 4, shape: 'ROUND',     status: 'RESERVED' },
    { id: 't2', tenantId: 'tenant-001', branchId: 'branch-001', areaId: 'area-main',    code: 'T-02', seats: 4, shape: 'SQUARE',    status: 'PREPARING' },
    { id: 't3', tenantId: 'tenant-001', branchId: 'branch-001', areaId: 'area-main',    code: 'T-03', seats: 6, shape: 'RECTANGLE', status: 'PAYMENT' },
    { id: 't4', tenantId: 'tenant-001', branchId: 'branch-001', areaId: 'area-main',    code: 'T-04', seats: 4, shape: 'SQUARE',    status: 'CLOSED' },
    { id: 't5', tenantId: 'tenant-001', branchId: 'branch-001', areaId: 'area-terraza', code: 'T-05', seats: 4, shape: 'SQUARE',    status: 'PREPARING' },
    { id: 't6', tenantId: 'tenant-001', branchId: 'branch-001', areaId: 'area-terraza', code: 'T-06', seats: 4, shape: 'ROUND',     status: 'RESERVED' },
    { id: 't7', tenantId: 'tenant-001', branchId: 'branch-001', areaId: 'area-bar',     code: 'T-07', seats: 2, shape: 'SQUARE',    status: 'AVAILABLE' },
    { id: 't8', tenantId: 'tenant-001', branchId: 'branch-001', areaId: 'area-bar',     code: 'T-08', seats: 2, shape: 'SQUARE',    status: 'AVAILABLE' },
  ];
  for (const table of tables) {
    await prisma.restaurantTable.upsert({
      where: { id: table.id },
      update: { areaId: table.areaId },
      create: table,
    });
  }
  console.log('✅ Tables');

  // ─── Orders ──────────────────────────────────────────────────────────────────
  const now = new Date();

  await prisma.order.upsert({
    where: { id: 'ORD-001' },
    update: {},
    create: {
      id: 'ORD-001',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      tableId: 't2',
      waiterId: 'user-003',
      status: 'OPEN',
      createdAt: new Date(now.getTime() - 24 * 60 * 1000), // hace 24 min
    },
  });
  await prisma.order.upsert({
    where: { id: 'ORD-002' },
    update: {},
    create: {
      id: 'ORD-002',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      tableId: 't3',
      waiterId: 'user-003',
      status: 'OPEN',
      createdAt: new Date(now.getTime() - 12 * 60 * 1000), // hace 12 min
    },
  });
  await prisma.order.upsert({
    where: { id: 'ORD-003' },
    update: {},
    create: {
      id: 'ORD-003',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      tableId: 't5',
      waiterId: 'user-003',
      status: 'OPEN',
      createdAt: new Date(now.getTime() - 15 * 60 * 1000), // hace 15 min
    },
  });
  console.log('✅ Orders');

  // ─── Order Items ─────────────────────────────────────────────────────────────
  // ORD-001: Bandeja×3 + Gaseosa×3 + Empanadas×2
  const orderItems = [
    { id: 'oi-001', orderId: 'ORD-001', productId: 'm5', name: 'Bandeja Paisa', priceCOP: 28000, qty: 3, sentQty: 3 },
    { id: 'oi-002', orderId: 'ORD-001', productId: 'm11', name: 'Gaseosa', priceCOP: 5000, qty: 3, sentQty: 3 },
    { id: 'oi-003', orderId: 'ORD-001', productId: 'm1', name: 'Empanadas x3', priceCOP: 12000, qty: 2, sentQty: 2 },
    // ORD-002: Ajiaco×1 + Limonada×1 + Natilla×1
    { id: 'oi-004', orderId: 'ORD-002', productId: 'm6', name: 'Ajiaco', priceCOP: 22000, qty: 1, sentQty: 1 },
    { id: 'oi-005', orderId: 'ORD-002', productId: 'm9', name: 'Limonada', priceCOP: 8000, qty: 1, sentQty: 1 },
    { id: 'oi-006', orderId: 'ORD-002', productId: 'm14', name: 'Natilla', priceCOP: 12000, qty: 1, sentQty: 1 },
    // ORD-003: Churrasco×2 + Jugo Natural×2
    { id: 'oi-007', orderId: 'ORD-003', productId: 'm7', name: 'Churrasco', priceCOP: 35000, qty: 2, sentQty: 2 },
    { id: 'oi-008', orderId: 'ORD-003', productId: 'm10', name: 'Jugo Natural', priceCOP: 9000, qty: 2, sentQty: 2 },
  ];
  for (const item of orderItems) {
    await prisma.orderItem.upsert({ where: { id: item.id }, update: {}, create: item });
  }
  console.log('✅ Order Items');

  // ─── Kitchen Tickets ─────────────────────────────────────────────────────────
  await prisma.kitchenTicket.upsert({
    where: { id: 'KS-001' },
    update: {},
    create: {
      id: 'KS-001',
      tenantId: 'tenant-001',
      orderId: 'ORD-001',
      status: 'PREPARING',
      sentAt: new Date(now.getTime() - 20 * 60 * 1000),
    },
  });
  await prisma.kitchenTicket.upsert({
    where: { id: 'KS-002' },
    update: {},
    create: {
      id: 'KS-002',
      tenantId: 'tenant-001',
      orderId: 'ORD-002',
      status: 'PENDING',
      sentAt: new Date(now.getTime() - 10 * 60 * 1000),
    },
  });
  await prisma.kitchenTicket.upsert({
    where: { id: 'KS-003' },
    update: {},
    create: {
      id: 'KS-003',
      tenantId: 'tenant-001',
      orderId: 'ORD-003',
      status: 'READY',
      sentAt: new Date(now.getTime() - 13 * 60 * 1000),
      readyAt: new Date(now.getTime() - 3 * 60 * 1000),
    },
  });

  // Kitchen ticket items
  const kitchenItems = [
    { id: 'kti-001', ticketId: 'KS-001', productId: 'm5', name: 'Bandeja Paisa', qty: 3 },
    { id: 'kti-002', ticketId: 'KS-001', productId: 'm11', name: 'Gaseosa', qty: 3 },
    { id: 'kti-003', ticketId: 'KS-001', productId: 'm1', name: 'Empanadas x3', qty: 2 },
    { id: 'kti-004', ticketId: 'KS-002', productId: 'm6', name: 'Ajiaco', qty: 1 },
    { id: 'kti-005', ticketId: 'KS-002', productId: 'm14', name: 'Natilla', qty: 1 },
    { id: 'kti-006', ticketId: 'KS-003', productId: 'm7', name: 'Churrasco', qty: 2 },
    { id: 'kti-007', ticketId: 'KS-003', productId: 'm10', name: 'Jugo Natural', qty: 2 },
  ];
  for (const ki of kitchenItems) {
    await prisma.kitchenTicketItem.upsert({ where: { id: ki.id }, update: {}, create: ki });
  }
  console.log('✅ Kitchen Tickets');

  console.log('🎉 Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
