import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * QA showcase seed.
 *
 * Keeps QA focused on two real demo accounts:
 * - Restaurant: diegocumbre.04@gmail.com / Cerro Monserrate
 * - Barber: carlosandreslizsanchez7@gmail.com / MALEXCA CEJAS Y PESTANAS
 *
 * The barber tenant already has real service data, so this script only validates
 * it. Restaurant demo data is created with fixed IDs and upserts, without
 * deleting user-created data.
 */

const prisma = new PrismaClient();

const ADMIN_EMAIL = 'admin@uselynko.com';

const RESTAURANT = {
  ownerEmail: 'diegocumbre.04@gmail.com',
  tenantId: 'tenant-bbf40bd3',
  branchId: 'branch-df7a1ba7',
  name: 'Cerro Monserrate',
  branchName: 'Sucursal Principal',
  address: 'Bogota, Colombia',
};

const BARBER = {
  ownerEmail: 'carlosandreslizsanchez7@gmail.com',
  tenantId: 'tenant-e2593413',
  branchId: 'branch-16e81337',
  name: 'MALEXCA CEJAS Y PESTANAS',
};

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function assertAdmin() {
  const admin = await prisma.user.findUnique({
    where: { email: ADMIN_EMAIL },
    select: {
      email: true,
      isActive: true,
      isPlatformAdmin: true,
      role: { select: { code: true } },
    },
  });

  if (!admin?.isActive || !admin.isPlatformAdmin || admin.role.code !== 'ROOT') {
    throw new Error(`${ADMIN_EMAIL} must exist as active ROOT platform admin`);
  }
}

async function assertBarberShowcase() {
  const owner = await prisma.user.findUnique({
    where: { email: BARBER.ownerEmail },
    select: {
      id: true,
      email: true,
      tenantId: true,
      isActive: true,
      tenant: {
        select: {
          id: true,
          name: true,
          status: true,
          vertical: { select: { code: true } },
          subscription: { select: { status: true } },
        },
      },
    },
  });

  if (!owner) throw new Error(`${BARBER.ownerEmail} not found`);
  if (owner.tenantId !== BARBER.tenantId) {
    throw new Error(`${BARBER.ownerEmail} is not linked to ${BARBER.tenantId}`);
  }
  if (
    !owner.isActive ||
    owner.tenant?.status !== 'ACTIVE' ||
    owner.tenant.subscription?.status !== 'ACTIVE' ||
    owner.tenant.vertical?.code !== 'barber'
  ) {
    throw new Error(`${BARBER.name} is not an active barber tenant`);
  }

  const [settings, activeServices, activeStaff] = await Promise.all([
    prisma.barberSettings.findUnique({
      where: { branchId: BARBER.branchId },
      select: { bookingSlug: true, onlineBookingEnabled: true },
    }),
    prisma.barberService.count({
      where: {
        tenantId: BARBER.tenantId,
        branchId: BARBER.branchId,
        isActive: true,
      },
    }),
    prisma.barberStaff.count({
      where: {
        tenantId: BARBER.tenantId,
        branchId: BARBER.branchId,
        isActive: true,
      },
    }),
  ]);

  if (!settings) throw new Error(`${BARBER.name} barber settings missing`);
  if (activeServices < 1) throw new Error(`${BARBER.name} has no active services`);
  if (activeStaff < 1) throw new Error(`${BARBER.name} has no active staff`);

  console.log(
    `✅ Barber showcase preserved: ${BARBER.ownerEmail}, services=${activeServices}, staff=${activeStaff}, slug=${settings.bookingSlug}`,
  );
}

async function seedRestaurantShowcase() {
  const owner = await prisma.user.findUnique({
    where: { email: RESTAURANT.ownerEmail },
    select: {
      id: true,
      email: true,
      tenantId: true,
      isActive: true,
      role: { select: { code: true } },
      tenant: {
        select: {
          id: true,
          vertical: { select: { code: true } },
          subscription: { select: { status: true } },
        },
      },
    },
  });

  if (!owner) throw new Error(`${RESTAURANT.ownerEmail} not found`);
  if (owner.tenantId !== RESTAURANT.tenantId) {
    throw new Error(
      `${RESTAURANT.ownerEmail} is not linked to ${RESTAURANT.tenantId}`,
    );
  }
  if (owner.role.code !== 'OWNER') {
    throw new Error(`${RESTAURANT.ownerEmail} must be OWNER`);
  }

  const vertical = await prisma.businessVertical.findUnique({
    where: { code: 'restaurant' },
    select: { id: true },
  });
  const plan = await prisma.subscriptionPlan.findUnique({
    where: { code: 'PRO' },
    select: { id: true },
  });
  if (!vertical) throw new Error('restaurant vertical missing; run npm run db:seed');
  if (!plan) throw new Error('PRO plan missing; run npm run db:seed');

  await prisma.tenant.update({
    where: { id: RESTAURANT.tenantId },
    data: {
      name: RESTAURANT.name,
      status: 'ACTIVE',
      plan: 'PRO',
      verticalId: vertical.id,
      planId: plan.id,
    },
  });
  await prisma.branch.update({
    where: { id: RESTAURANT.branchId },
    data: { name: RESTAURANT.branchName, address: RESTAURANT.address },
  });
  await prisma.user.update({
    where: { id: owner.id },
    data: { isActive: true },
  });
  await prisma.userBranch.upsert({
    where: {
      userId_branchId: { userId: owner.id, branchId: RESTAURANT.branchId },
    },
    update: {},
    create: { userId: owner.id, branchId: RESTAURANT.branchId },
  });

  const now = new Date();
  const periodMonth = monthKey(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const categories = [
    { id: 'qa-rest-cat-entradas', name: 'Entradas', emoji: '🥟', sortOrder: 10 },
    { id: 'qa-rest-cat-platos', name: 'Platos fuertes', emoji: '🍽️', sortOrder: 20 },
    { id: 'qa-rest-cat-bebidas', name: 'Bebidas', emoji: '🥤', sortOrder: 30 },
    { id: 'qa-rest-cat-postres', name: 'Postres', emoji: '🍰', sortOrder: 40 },
  ];

  for (const category of categories) {
    await prisma.productCategory.upsert({
      where: { id: category.id },
      update: {
        tenantId: RESTAURANT.tenantId,
        branchId: RESTAURANT.branchId,
        name: category.name,
        emoji: category.emoji,
        sortOrder: category.sortOrder,
      },
      create: {
        ...category,
        tenantId: RESTAURANT.tenantId,
        branchId: RESTAURANT.branchId,
      },
    });
  }

  const products = [
    {
      id: 'qa-rest-prod-empanadas',
      categoryId: 'qa-rest-cat-entradas',
      name: 'Empanadas x3',
      description: 'Empanadas doradas con aji de la casa.',
      priceCOP: 12000,
      emoji: '🥟',
      sortOrder: 10,
    },
    {
      id: 'qa-rest-prod-patacones',
      categoryId: 'qa-rest-cat-entradas',
      name: 'Patacones con hogao',
      description: 'Patacones crocantes para compartir.',
      priceCOP: 14000,
      emoji: '🫓',
      sortOrder: 20,
    },
    {
      id: 'qa-rest-prod-bandeja',
      categoryId: 'qa-rest-cat-platos',
      name: 'Bandeja paisa',
      description: 'Frijol, arroz, carne molida, chicharron, huevo y aguacate.',
      priceCOP: 32000,
      emoji: '🍛',
      sortOrder: 10,
    },
    {
      id: 'qa-rest-prod-ajiaco',
      categoryId: 'qa-rest-cat-platos',
      name: 'Ajiaco santafereño',
      description: 'Sopa tradicional con pollo, papa criolla, mazorca y alcaparras.',
      priceCOP: 28000,
      emoji: '🥘',
      sortOrder: 20,
    },
    {
      id: 'qa-rest-prod-churrasco',
      categoryId: 'qa-rest-cat-platos',
      name: 'Churrasco',
      description: 'Corte a la parrilla con papas y ensalada.',
      priceCOP: 38000,
      emoji: '🥩',
      sortOrder: 30,
    },
    {
      id: 'qa-rest-prod-limonada',
      categoryId: 'qa-rest-cat-bebidas',
      name: 'Limonada natural',
      description: 'Preparada al momento.',
      priceCOP: 8000,
      emoji: '🍋',
      sortOrder: 10,
    },
    {
      id: 'qa-rest-prod-jugo',
      categoryId: 'qa-rest-cat-bebidas',
      name: 'Jugo natural',
      description: 'Mora, mango o lulo.',
      priceCOP: 9000,
      emoji: '🧃',
      sortOrder: 20,
    },
    {
      id: 'qa-rest-prod-tres-leches',
      categoryId: 'qa-rest-cat-postres',
      name: 'Tres leches',
      description: 'Postre frio de la casa.',
      priceCOP: 14000,
      emoji: '🍰',
      sortOrder: 10,
    },
  ];

  for (const product of products) {
    await prisma.product.upsert({
      where: { id: product.id },
      update: {
        tenantId: RESTAURANT.tenantId,
        branchId: RESTAURANT.branchId,
        categoryId: product.categoryId,
        name: product.name,
        description: product.description,
        priceCOP: product.priceCOP,
        emoji: product.emoji,
        imageUrls: [],
        isAvailable: true,
        sortOrder: product.sortOrder,
        deletedAt: null,
      },
      create: {
        ...product,
        tenantId: RESTAURANT.tenantId,
        branchId: RESTAURANT.branchId,
        imageUrls: [],
        isAvailable: true,
      },
    });
  }

  // ─── Inventario: ingredientes + recetas + compra inicial ──────────────────
  // Espeja la lógica de inventory.service (calculateMetrics / convertQuantity)
  // para que los campos derivados queden coherentes al sembrar por Prisma.
  const GRAMS: Record<string, number> = { g: 1, kg: 1000, lb: 453.59237 };
  const ML: Record<string, number> = { ml: 1, L: 1000 };
  const convertQty = (q: number, from: string, to: string) => {
    if (from === to) return q;
    if (from in GRAMS && to in GRAMS) return (q * GRAMS[from]) / GRAMS[to];
    if (from in ML && to in ML) return (q * ML[from]) / ML[to];
    throw new Error(`Incompatible units ${from} -> ${to}`);
  };

  const ingredients = [
    { id: 'qa-ing-carne', name: 'Carne de res', categoryId: 'proteinas', purchaseUnit: 'kg', recipeUnit: 'g', stock: 20, waste: 10, cost: 360_000, minStock: 3, supplier: 'Carnes El Novillo' },
    { id: 'qa-ing-pollo', name: 'Pechuga de pollo', categoryId: 'proteinas', purchaseUnit: 'kg', recipeUnit: 'g', stock: 15, waste: 8, cost: 180_000, minStock: 3, supplier: 'Avicola La Granja' },
    { id: 'qa-ing-arroz', name: 'Arroz', categoryId: 'granos', purchaseUnit: 'kg', recipeUnit: 'g', stock: 25, waste: 0, cost: 87_500, minStock: 5, supplier: 'Distribuidora Central' },
    { id: 'qa-ing-frijol', name: 'Frijol', categoryId: 'granos', purchaseUnit: 'kg', recipeUnit: 'g', stock: 15, waste: 2, cost: 120_000, minStock: 3, supplier: 'Distribuidora Central' },
    { id: 'qa-ing-papa', name: 'Papa criolla', categoryId: 'verduras', purchaseUnit: 'kg', recipeUnit: 'g', stock: 30, waste: 12, cost: 90_000, minStock: 5, supplier: 'Plaza de Mercado' },
    { id: 'qa-ing-huevo', name: 'Huevo', categoryId: 'proteinas', purchaseUnit: 'unit', recipeUnit: 'unit', stock: 200, waste: 0, cost: 60_000, minStock: 30, supplier: 'Avicola La Granja' },
    { id: 'qa-ing-aguacate', name: 'Aguacate', categoryId: 'verduras', purchaseUnit: 'unit', recipeUnit: 'unit', stock: 60, waste: 15, cost: 90_000, minStock: 10, supplier: 'Plaza de Mercado' },
    { id: 'qa-ing-platano', name: 'Platano', categoryId: 'verduras', purchaseUnit: 'unit', recipeUnit: 'unit', stock: 80, waste: 10, cost: 64_000, minStock: 15, supplier: 'Plaza de Mercado' },
    { id: 'qa-ing-limon', name: 'Limon', categoryId: 'frutas', purchaseUnit: 'unit', recipeUnit: 'unit', stock: 120, waste: 5, cost: 36_000, minStock: 20, supplier: 'Plaza de Mercado' },
    { id: 'qa-ing-leche', name: 'Leche', categoryId: 'lacteos', purchaseUnit: 'L', recipeUnit: 'ml', stock: 30, waste: 0, cost: 90_000, minStock: 5, supplier: 'Alpina' },
    { id: 'qa-ing-maiz', name: 'Mazorca', categoryId: 'verduras', purchaseUnit: 'unit', recipeUnit: 'unit', stock: 40, waste: 5, cost: 60_000, minStock: 8, supplier: 'Plaza de Mercado' },
  ];

  for (const ing of ingredients) {
    const grossInRecipe = convertQty(ing.stock, ing.purchaseUnit, ing.recipeUnit);
    const usableRatio = 1 - ing.waste / 100;
    const netUsableQuantity = grossInRecipe * usableRatio;
    const grossUnitCost = ing.stock > 0 ? ing.cost / ing.stock : 0;
    const netUnitCost = netUsableQuantity > 0 ? ing.cost / netUsableQuantity : 0;

    const fields = {
      tenantId: RESTAURANT.tenantId,
      branchId: RESTAURANT.branchId,
      categoryId: ing.categoryId,
      name: ing.name,
      purchaseUnit: ing.purchaseUnit,
      recipeUnit: ing.recipeUnit,
      grossStockQuantity: ing.stock,
      currentStock: ing.stock,
      netUsableQuantity,
      technicalWastePercentage: ing.waste,
      totalPurchaseCost: ing.cost,
      grossUnitCost,
      netUnitCost,
      minStock: ing.minStock,
      supplierName: ing.supplier,
      isActive: true,
    };

    await prisma.ingredient.upsert({
      where: { id: ing.id },
      update: fields,
      create: { id: ing.id, ...fields },
    });

    // Movimiento de compra inicial (id fijo => idempotente).
    await prisma.stockMovement.upsert({
      where: { id: `qa-mov-purchase-${ing.id}` },
      update: {
        quantity: ing.stock,
        unitCost: ing.stock > 0 ? ing.cost / ing.stock : null,
        previousStock: 0,
        newStock: ing.stock,
      },
      create: {
        id: `qa-mov-purchase-${ing.id}`,
        tenantId: RESTAURANT.tenantId,
        branchId: RESTAURANT.branchId,
        ingredientId: ing.id,
        type: 'PURCHASE',
        quantity: ing.stock,
        unitCost: ing.stock > 0 ? ing.cost / ing.stock : null,
        previousStock: 0,
        newStock: ing.stock,
        notes: 'Compra inicial (seed QA)',
        createdBy: owner.id,
        createdByName: owner.email,
      },
    });
  }

  const recipeLines = [
    // Bandeja paisa
    { productId: 'qa-rest-prod-bandeja', ingredientId: 'qa-ing-carne', quantity: 150, unit: 'g' },
    { productId: 'qa-rest-prod-bandeja', ingredientId: 'qa-ing-arroz', quantity: 120, unit: 'g' },
    { productId: 'qa-rest-prod-bandeja', ingredientId: 'qa-ing-frijol', quantity: 100, unit: 'g' },
    { productId: 'qa-rest-prod-bandeja', ingredientId: 'qa-ing-huevo', quantity: 1, unit: 'unit' },
    { productId: 'qa-rest-prod-bandeja', ingredientId: 'qa-ing-aguacate', quantity: 0.5, unit: 'unit' },
    { productId: 'qa-rest-prod-bandeja', ingredientId: 'qa-ing-platano', quantity: 1, unit: 'unit' },
    // Ajiaco
    { productId: 'qa-rest-prod-ajiaco', ingredientId: 'qa-ing-pollo', quantity: 180, unit: 'g' },
    { productId: 'qa-rest-prod-ajiaco', ingredientId: 'qa-ing-papa', quantity: 250, unit: 'g' },
    { productId: 'qa-rest-prod-ajiaco', ingredientId: 'qa-ing-maiz', quantity: 1, unit: 'unit' },
    // Churrasco
    { productId: 'qa-rest-prod-churrasco', ingredientId: 'qa-ing-carne', quantity: 250, unit: 'g' },
    { productId: 'qa-rest-prod-churrasco', ingredientId: 'qa-ing-papa', quantity: 200, unit: 'g' },
    // Limonada
    { productId: 'qa-rest-prod-limonada', ingredientId: 'qa-ing-limon', quantity: 3, unit: 'unit' },
    // Tres leches
    { productId: 'qa-rest-prod-tres-leches', ingredientId: 'qa-ing-leche', quantity: 200, unit: 'ml' },
    { productId: 'qa-rest-prod-tres-leches', ingredientId: 'qa-ing-huevo', quantity: 2, unit: 'unit' },
  ];

  for (const line of recipeLines) {
    await prisma.recipeLine.upsert({
      where: {
        productId_ingredientId: {
          productId: line.productId,
          ingredientId: line.ingredientId,
        },
      },
      update: { quantity: line.quantity, unit: line.unit },
      create: {
        tenantId: RESTAURANT.tenantId,
        branchId: RESTAURANT.branchId,
        productId: line.productId,
        ingredientId: line.ingredientId,
        quantity: line.quantity,
        unit: line.unit,
      },
    });
  }

  const areas = [
    { id: 'qa-rest-area-salon', name: 'Salon principal', emoji: '🍽️' },
    { id: 'qa-rest-area-terraza', name: 'Terraza', emoji: '🌿' },
    { id: 'qa-rest-area-bar', name: 'Bar', emoji: '🍹' },
  ];
  for (const area of areas) {
    await prisma.area.upsert({
      where: { id: area.id },
      update: {
        tenantId: RESTAURANT.tenantId,
        branchId: RESTAURANT.branchId,
        name: area.name,
        emoji: area.emoji,
      },
      create: {
        ...area,
        tenantId: RESTAURANT.tenantId,
        branchId: RESTAURANT.branchId,
      },
    });
  }

  const tables = [
    { id: 'qa-rest-table-01', areaId: 'qa-rest-area-salon', code: 'M-01', seats: 4, shape: 'ROUND', status: 'RESERVED' },
    { id: 'qa-rest-table-02', areaId: 'qa-rest-area-salon', code: 'M-02', seats: 4, shape: 'SQUARE', status: 'PREPARING' },
    { id: 'qa-rest-table-03', areaId: 'qa-rest-area-salon', code: 'M-03', seats: 6, shape: 'RECTANGLE', status: 'PAYMENT' },
    { id: 'qa-rest-table-04', areaId: 'qa-rest-area-terraza', code: 'T-01', seats: 4, shape: 'SQUARE', status: 'AVAILABLE' },
    { id: 'qa-rest-table-05', areaId: 'qa-rest-area-terraza', code: 'T-02', seats: 4, shape: 'ROUND', status: 'RESERVED' },
    { id: 'qa-rest-table-06', areaId: 'qa-rest-area-bar', code: 'B-01', seats: 2, shape: 'SQUARE', status: 'AVAILABLE' },
  ];
  for (const table of tables) {
    await prisma.restaurantTable.upsert({
      where: { id: table.id },
      update: {
        areaId: table.areaId,
        code: table.code,
        seats: table.seats,
        shape: table.shape,
        status: table.status,
      },
      create: {
        ...table,
        tenantId: RESTAURANT.tenantId,
        branchId: RESTAURANT.branchId,
      },
    });
  }

  const orders = [
    {
      id: 'qa-rest-order-001',
      tableId: 'qa-rest-table-02',
      status: 'OPEN',
      createdAt: new Date(now.getTime() - 22 * 60 * 1000),
      items: [
        { productId: 'qa-rest-prod-bandeja', name: 'Bandeja paisa', priceCOP: 32000, qty: 2 },
        { productId: 'qa-rest-prod-limonada', name: 'Limonada natural', priceCOP: 8000, qty: 2 },
      ],
    },
    {
      id: 'qa-rest-order-002',
      tableId: 'qa-rest-table-03',
      status: 'OPEN',
      createdAt: new Date(now.getTime() - 12 * 60 * 1000),
      items: [
        { productId: 'qa-rest-prod-ajiaco', name: 'Ajiaco santafereño', priceCOP: 28000, qty: 1 },
        { productId: 'qa-rest-prod-tres-leches', name: 'Tres leches', priceCOP: 14000, qty: 1 },
      ],
    },
  ];

  for (const order of orders) {
    await prisma.order.upsert({
      where: { id: order.id },
      update: {
        tableId: order.tableId,
        waiterId: owner.id,
        status: order.status,
        createdAt: order.createdAt,
      },
      create: {
        id: order.id,
        tenantId: RESTAURANT.tenantId,
        branchId: RESTAURANT.branchId,
        tableId: order.tableId,
        waiterId: owner.id,
        status: order.status,
        createdAt: order.createdAt,
      },
    });

    for (const item of order.items) {
      await prisma.orderItem.upsert({
        where: {
          orderId_lineKey: { orderId: order.id, lineKey: item.productId },
        },
        update: {
          name: item.name,
          priceCOP: item.priceCOP,
          qty: item.qty,
          sentQty: item.qty,
        },
        create: {
          orderId: order.id,
          productId: item.productId,
          lineKey: item.productId,
          name: item.name,
          priceCOP: item.priceCOP,
          qty: item.qty,
          sentQty: item.qty,
        },
      });
    }
  }

  const reservationStart = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  await prisma.reservation.upsert({
    where: { id: 'qa-rest-reservation-001' },
    update: {
      tableId: 'qa-rest-table-01',
      guestName: 'Familia Gomez',
      guestPhone: '+573001112233',
      partySize: 4,
      scheduledAt: reservationStart,
      scheduledEnd: new Date(reservationStart.getTime() + 2 * 60 * 60 * 1000),
      occasion: 'birthday',
      occasionNote: 'Cumpleanos familiar',
      status: 'ACTIVE',
    },
    create: {
      id: 'qa-rest-reservation-001',
      tenantId: RESTAURANT.tenantId,
      branchId: RESTAURANT.branchId,
      tableId: 'qa-rest-table-01',
      guestName: 'Familia Gomez',
      guestPhone: '+573001112233',
      partySize: 4,
      scheduledAt: reservationStart,
      scheduledEnd: new Date(reservationStart.getTime() + 2 * 60 * 60 * 1000),
      occasion: 'birthday',
      occasionNote: 'Cumpleanos familiar',
      status: 'ACTIVE',
    },
  });

  const expenses = [
    { id: 'qa-rest-exp-rent', category: 'rent', concept: 'Arriendo local', amountCOP: 3_500_000, day: 1 },
    { id: 'qa-rest-exp-utilities', category: 'utilities', concept: 'Servicios publicos', amountCOP: 480_000, day: 5 },
    { id: 'qa-rest-exp-supplies', category: 'supplies', concept: 'Insumos cocina', amountCOP: 1_250_000, day: 8 },
    { id: 'qa-rest-exp-marketing', category: 'marketing', concept: 'Campana redes sociales', amountCOP: 320_000, day: 12 },
  ];
  for (const expense of expenses) {
    await prisma.expense.upsert({
      where: { id: expense.id },
      update: {
        category: expense.category,
        concept: expense.concept,
        amountCOP: expense.amountCOP,
        incurredAt: new Date(monthStart.getTime() + expense.day * 24 * 60 * 60 * 1000),
      },
      create: {
        id: expense.id,
        tenantId: RESTAURANT.tenantId,
        branchId: RESTAURANT.branchId,
        category: expense.category,
        concept: expense.concept,
        amountCOP: expense.amountCOP,
        incurredAt: new Date(monthStart.getTime() + expense.day * 24 * 60 * 60 * 1000),
      },
    });
  }

  await prisma.payroll.upsert({
    where: {
      branchId_userId_periodMonth: {
        branchId: RESTAURANT.branchId,
        userId: owner.id,
        periodMonth,
      },
    },
    update: {
      staffName: owner.email,
      role: 'OWNER',
      grossCOP: 3_200_000,
      netCOP: 2_880_000,
      paidAt: monthStart,
    },
    create: {
      id: `qa-rest-payroll-owner-${periodMonth}`,
      tenantId: RESTAURANT.tenantId,
      branchId: RESTAURANT.branchId,
      userId: owner.id,
      staffName: owner.email,
      role: 'OWNER',
      periodMonth,
      grossCOP: 3_200_000,
      netCOP: 2_880_000,
      paidAt: monthStart,
    },
  });

  for (const goal of [
    { id: `qa-rest-goal-revenue-${periodMonth}`, metric: 'revenue', targetCOP: 30_000_000 },
    { id: `qa-rest-goal-profit-${periodMonth}`, metric: 'profit', targetCOP: 9_000_000 },
  ]) {
    await prisma.financeGoal.upsert({
      where: {
        branchId_periodMonth_metric: {
          branchId: RESTAURANT.branchId,
          periodMonth,
          metric: goal.metric,
        },
      },
      update: { targetCOP: goal.targetCOP },
      create: {
        id: goal.id,
        tenantId: RESTAURANT.tenantId,
        branchId: RESTAURANT.branchId,
        periodMonth,
        metric: goal.metric,
        targetCOP: goal.targetCOP,
      },
    });
  }

  await prisma.menuPublicConfig.upsert({
    where: { tenantId: RESTAURANT.tenantId },
    update: {
      branchId: RESTAURANT.branchId,
      slug: 'cerro-monserrate',
      isPublished: true,
      showPrices: true,
      showDescription: true,
      templateId: 'cards',
      primaryColor: '#16a34a',
      accentColor: '#f59e0b',
      logoMode: 'emoji',
      logoEmoji: '⛰️',
      heroTitle: RESTAURANT.name,
      heroDescription: 'Cocina colombiana para pruebas integrales de QA.',
      featuredProductIds: ['qa-rest-prod-bandeja', 'qa-rest-prod-ajiaco'],
      categoryOrder: categories.map((category) => category.id),
    },
    create: {
      tenantId: RESTAURANT.tenantId,
      branchId: RESTAURANT.branchId,
      slug: 'cerro-monserrate',
      isPublished: true,
      showPrices: true,
      showDescription: true,
      templateId: 'cards',
      primaryColor: '#16a34a',
      accentColor: '#f59e0b',
      logoMode: 'emoji',
      logoEmoji: '⛰️',
      heroTitle: RESTAURANT.name,
      heroDescription: 'Cocina colombiana para pruebas integrales de QA.',
      featuredProductIds: ['qa-rest-prod-bandeja', 'qa-rest-prod-ajiaco'],
      categoryOrder: categories.map((category) => category.id),
    },
  });

  console.log(
    `✅ Restaurant showcase seeded: ${RESTAURANT.ownerEmail}, tenant=${RESTAURANT.tenantId}, branch=${RESTAURANT.branchId}`,
  );
}

async function main() {
  await assertAdmin();
  await assertBarberShowcase();
  await seedRestaurantShowcase();
  console.log('🎉 QA showcase ready.');
}

main()
  .catch((error) => {
    console.error('❌ QA showcase seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
