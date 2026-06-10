import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─── Permission catalog ──────────────────────────────────────────────────────
const PERMISSIONS: Array<{
  code: string;
  resource: string;
  action: string;
  description: string;
}> = [
  {
    code: 'restaurant:menu:read',
    resource: 'menu',
    action: 'read',
    description: 'Ver el menú',
  },
  {
    code: 'restaurant:menu:write',
    resource: 'menu',
    action: 'write',
    description: 'Crear/editar productos',
  },
  {
    code: 'restaurant:menu:delete',
    resource: 'menu',
    action: 'delete',
    description: 'Eliminar productos',
  },
  {
    code: 'restaurant:tables:read',
    resource: 'tables',
    action: 'read',
    description: 'Ver mesas y áreas',
  },
  {
    code: 'restaurant:tables:write',
    resource: 'tables',
    action: 'write',
    description: 'Crear/editar mesas y áreas',
  },
  {
    code: 'restaurant:orders:read',
    resource: 'orders',
    action: 'read',
    description: 'Ver órdenes',
  },
  {
    code: 'restaurant:orders:write',
    resource: 'orders',
    action: 'write',
    description: 'Crear/editar órdenes',
  },
  {
    code: 'restaurant:orders:delete',
    resource: 'orders',
    action: 'delete',
    description: 'Eliminar ítems',
  },
  {
    code: 'restaurant:orders:close',
    resource: 'orders',
    action: 'close',
    description: 'Cerrar órdenes',
  },
  {
    code: 'restaurant:kitchen:read',
    resource: 'kitchen',
    action: 'read',
    description: 'Ver comanda',
  },
  {
    code: 'restaurant:kitchen:write',
    resource: 'kitchen',
    action: 'write',
    description: 'Actualizar estados de cocina',
  },
  {
    code: 'restaurant:payments:read',
    resource: 'payments',
    action: 'read',
    description: 'Ver pagos',
  },
  {
    code: 'restaurant:payments:write',
    resource: 'payments',
    action: 'write',
    description: 'Registrar pagos',
  },
  {
    code: 'restaurant:reservations:read',
    resource: 'reservations',
    action: 'read',
    description: 'Ver reservas',
  },
  {
    code: 'restaurant:reservations:write',
    resource: 'reservations',
    action: 'write',
    description: 'Crear/editar reservas',
  },
  {
    code: 'restaurant:finance:read',
    resource: 'finance',
    action: 'read',
    description: 'Ver finanzas (dashboard, gastos, nómina, metas)',
  },
  {
    code: 'restaurant:staff:read',
    resource: 'staff',
    action: 'read',
    description: 'Ver personal',
  },
  {
    code: 'restaurant:staff:write',
    resource: 'staff',
    action: 'write',
    description: 'Gestionar personal',
  },
  {
    code: 'restaurant:settings:read',
    resource: 'settings',
    action: 'read',
    description: 'Ver configuración',
  },
  {
    code: 'restaurant:settings:write',
    resource: 'settings',
    action: 'write',
    description: 'Editar configuración y branches',
  },
  {
    code: 'restaurant:menu-public:read',
    resource: 'menu-public',
    action: 'read',
    description: 'Ver configuración de la carta pública',
  },
  {
    code: 'restaurant:menu-public:write',
    resource: 'menu-public',
    action: 'write',
    description: 'Editar configuración de la carta pública',
  },
  {
    code: 'restaurant:menu-public:publish',
    resource: 'menu-public',
    action: 'publish',
    description: 'Publicar/despublicar la carta pública',
  },
  {
    code: 'restaurant:sales:read',
    resource: 'sales',
    action: 'read',
    description: 'Ver historial de ventas y tiempos',
  },
  {
    code: 'restaurant:claims:create',
    resource: 'claims',
    action: 'create',
    description: 'Registrar reclamos sobre órdenes/ventas',
  },
  {
    code: 'restaurant:printers:read',
    resource: 'printers',
    action: 'read',
    description: 'Ver impresoras configuradas',
  },
  {
    code: 'restaurant:printers:manage',
    resource: 'printers',
    action: 'manage',
    description: 'Crear/editar/eliminar impresoras',
  },
  {
    code: 'restaurant:print:create',
    resource: 'print',
    action: 'create',
    description: 'Enviar trabajos de impresión',
  },
  {
    code: 'restaurant:print:read',
    resource: 'print',
    action: 'read',
    description: 'Ver cola de impresión',
  },
  {
    code: 'restaurant:print:update',
    resource: 'print',
    action: 'update',
    description: 'Marcar trabajos de impresión (ack/fail/retry)',
  },
  {
    code: 'restaurant:cash:read',
    resource: 'cash',
    action: 'read',
    description: 'Ver arqueo de caja',
  },
  {
    code: 'restaurant:cash:manage',
    resource: 'cash',
    action: 'manage',
    description: 'Abrir/cerrar caja y registrar movimientos',
  },
  {
    code: 'barber:settings:read',
    resource: 'barber-settings',
    action: 'read',
    description: 'Ver configuración de barbería',
  },
  {
    code: 'barber:settings:write',
    resource: 'barber-settings',
    action: 'write',
    description: 'Editar configuración de barbería',
  },
  {
    code: 'barber:services:read',
    resource: 'barber-services',
    action: 'read',
    description: 'Ver servicios de barbería',
  },
  {
    code: 'barber:services:write',
    resource: 'barber-services',
    action: 'write',
    description: 'Crear/editar servicios de barbería',
  },
  {
    code: 'barber:staff:read',
    resource: 'barber-staff',
    action: 'read',
    description: 'Ver especialistas de barbería',
  },
  {
    code: 'barber:staff:write',
    resource: 'barber-staff',
    action: 'write',
    description: 'Crear/editar especialistas de barbería',
  },
  {
    code: 'barber:customers:read',
    resource: 'barber-customers',
    action: 'read',
    description: 'Ver clientes de barbería',
  },
  {
    code: 'barber:customers:write',
    resource: 'barber-customers',
    action: 'write',
    description: 'Crear/editar clientes de barbería',
  },
  {
    code: 'barber:appointments:read',
    resource: 'barber-appointments',
    action: 'read',
    description: 'Ver agenda de barbería',
  },
  {
    code: 'barber:appointments:write',
    resource: 'barber-appointments',
    action: 'write',
    description: 'Crear/editar citas de barbería',
  },
  {
    code: 'admin:tenants:manage',
    resource: 'tenants',
    action: 'manage',
    description: 'CRUD de tenants (ROOT)',
  },
  {
    code: 'admin:users:invite',
    resource: 'users',
    action: 'invite',
    description: 'Invitar y asignar usuarios',
  },
  {
    code: 'admin:roles:manage',
    resource: 'roles',
    action: 'manage',
    description: 'Gestionar roles y permisos',
  },
];

const ALL_PERMS = PERMISSIONS.map((p) => p.code);
const RESTAURANT_PERMS = ALL_PERMS.filter((c) => c.startsWith('restaurant:'));
const BARBER_PERMS = ALL_PERMS.filter((c) => c.startsWith('barber:'));

const VERTICALS = [
  { id: 'vertical-restaurant', code: 'restaurant', name: 'Restaurante' },
  { id: 'vertical-barber', code: 'barber', name: 'Barberia' },
];

const PLANS = [
  { id: 'plan-basic', code: 'BASIC', name: 'Basic', priceCOP: 0 },
  { id: 'plan-pro', code: 'PRO', name: 'Pro', priceCOP: 99000 },
  { id: 'plan-premium', code: 'PREMIUM', name: 'Premium', priceCOP: 199000 },
];

// ─── System role matrix ──────────────────────────────────────────────────────
// ROOT se maneja aparte (tenantId=null, todos los permisos).
const SYSTEM_ROLES: Array<{
  code: string;
  name: string;
  permissions: string[];
}> = [
  {
    code: 'OWNER',
    name: 'Dueño',
    permissions: [
      ...RESTAURANT_PERMS,
      ...BARBER_PERMS,
      'admin:users:invite',
      'admin:roles:manage',
    ],
  },
  {
    code: 'MANAGER',
    name: 'Gerente',
    permissions: [
      'restaurant:menu:read',
      'restaurant:menu:write',
      'restaurant:tables:read',
      'restaurant:tables:write',
      'restaurant:orders:read',
      'restaurant:orders:write',
      'restaurant:orders:close',
      'restaurant:kitchen:read',
      'restaurant:kitchen:write',
      'restaurant:payments:read',
      'restaurant:payments:write',
      'restaurant:reservations:read',
      'restaurant:reservations:write',
      'restaurant:finance:read',
      'restaurant:staff:read',
      'restaurant:staff:write',
      'restaurant:settings:read',
      'restaurant:menu-public:read',
      'restaurant:menu-public:write',
      'restaurant:menu-public:publish',
      'restaurant:sales:read',
      'restaurant:claims:create',
      'restaurant:printers:read',
      'restaurant:printers:manage',
      'restaurant:print:create',
      'restaurant:print:read',
      'restaurant:print:update',
      'restaurant:cash:read',
      'restaurant:cash:manage',
      ...BARBER_PERMS,
      'admin:users:invite',
    ],
  },
  {
    code: 'CASHIER',
    name: 'Cajero',
    permissions: [
      'restaurant:menu:read',
      'restaurant:tables:read',
      'restaurant:orders:read',
      'restaurant:orders:write',
      'restaurant:orders:close',
      'restaurant:payments:read',
      'restaurant:payments:write',
      'restaurant:reservations:read',
      'restaurant:sales:read',
      'restaurant:claims:create',
      'restaurant:printers:read',
      'restaurant:print:create',
      'restaurant:print:read',
      'restaurant:print:update',
      'restaurant:cash:read',
      'restaurant:cash:manage',
    ],
  },
  {
    code: 'WAITER',
    name: 'Mesero',
    permissions: [
      'restaurant:menu:read',
      'restaurant:tables:read',
      'restaurant:orders:read',
      'restaurant:orders:write',
      'restaurant:kitchen:read',
      'restaurant:reservations:read',
      'restaurant:reservations:write',
      'restaurant:claims:create',
      'restaurant:print:create',
    ],
  },
  {
    code: 'KITCHEN',
    name: 'Cocina',
    permissions: [
      'restaurant:orders:read',
      'restaurant:kitchen:read',
      'restaurant:kitchen:write',
      'restaurant:printers:read',
      'restaurant:print:create',
      'restaurant:print:read',
    ],
  },
  {
    code: 'ADMIN',
    name: 'Administrativo',
    permissions: [
      'restaurant:staff:read',
      'restaurant:staff:write',
      'restaurant:finance:read',
      'restaurant:reservations:read',
      'restaurant:settings:read',
      'restaurant:settings:write',
      'restaurant:sales:read',
      'restaurant:printers:read',
      'restaurant:printers:manage',
      'restaurant:cash:read',
    ],
  },
];

async function seedSystemRolesForTenant(tenantId: string | null) {
  const permRows = await prisma.permission.findMany();
  const permMap = new Map(permRows.map((p) => [p.code, p.id]));

  // ROOT solo si tenantId === null.
  // Postgres trata múltiples nulls como distintos → el @@unique no es idempotente
  // con tenantId=null, así que hacemos find + create manualmente.
  if (tenantId === null) {
    let root = await prisma.role.findFirst({
      where: { tenantId: null, code: 'ROOT' },
    });
    if (!root) {
      root = await prisma.role.create({
        data: { tenantId: null, code: 'ROOT', name: 'Root', isSystem: true },
      });
    } else {
      root = await prisma.role.update({
        where: { id: root.id },
        data: { name: 'Root', isSystem: true },
      });
    }
    await prisma.rolePermission.deleteMany({ where: { roleId: root.id } });
    await prisma.rolePermission.createMany({
      data: ALL_PERMS.map((code) => ({
        roleId: root.id,
        permissionId: permMap.get(code)!,
      })),
      skipDuplicates: true,
    });
    return;
  }

  for (const def of SYSTEM_ROLES) {
    const role = await prisma.role.upsert({
      where: { tenantId_code: { tenantId, code: def.code } },
      update: { name: def.name, isSystem: true },
      create: { tenantId, code: def.code, name: def.name, isSystem: true },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: def.permissions.map((code) => ({
        roleId: role.id,
        permissionId: permMap.get(code)!,
      })),
      skipDuplicates: true,
    });
  }
}

async function main() {
  console.log('🌱 Starting seed...');

  // ─── Permissions catalog ────────────────────────────────────────────────────
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      update: {
        resource: p.resource,
        action: p.action,
        description: p.description,
      },
      create: p,
    });
  }
  console.log('✅ Permissions');

  // ─── Business verticals + subscription plans ───────────────────────────────
  for (const vertical of VERTICALS) {
    await prisma.businessVertical.upsert({
      where: { code: vertical.code },
      update: { name: vertical.name, isActive: true },
      create: { ...vertical, isActive: true },
    });
  }

  for (const plan of PLANS) {
    await prisma.subscriptionPlan.upsert({
      where: { code: plan.code },
      update: {
        name: plan.name,
        priceCOP: plan.priceCOP,
        currency: 'COP',
        isActive: true,
      },
      create: {
        ...plan,
        currency: 'COP',
        isActive: true,
      },
    });
  }

  for (const vertical of VERTICALS) {
    for (const plan of PLANS) {
      await prisma.verticalPlan.upsert({
        where: {
          verticalId_planId: {
            verticalId: vertical.id,
            planId: plan.id,
          },
        },
        update: { isActive: true },
        create: {
          verticalId: vertical.id,
          planId: plan.id,
          isActive: true,
        },
      });
    }
  }
  console.log('✅ Verticals + plans');

  // ─── Tenants ────────────────────────────────────────────────────────────────
  await prisma.tenant.upsert({
    where: { id: 'tenant-001' },
    update: {
      verticalId: 'vertical-restaurant',
      planId: 'plan-pro',
      plan: 'PRO',
    },
    create: {
      id: 'tenant-001',
      name: 'OriWok',
      plan: 'PRO',
      verticalId: 'vertical-restaurant',
      planId: 'plan-pro',
    },
  });
  await prisma.tenant.upsert({
    where: { id: 'tenant-002' },
    update: {
      verticalId: 'vertical-restaurant',
      planId: 'plan-basic',
      plan: 'BASIC',
    },
    create: {
      id: 'tenant-002',
      name: 'La Parrilla',
      plan: 'BASIC',
      verticalId: 'vertical-restaurant',
      planId: 'plan-basic',
    },
  });
  await prisma.tenant.upsert({
    where: { id: 'tenant-barber-001' },
    update: { verticalId: 'vertical-barber', planId: 'plan-pro', plan: 'PRO' },
    create: {
      id: 'tenant-barber-001',
      name: 'Tijeras y Arte',
      plan: 'PRO',
      verticalId: 'vertical-barber',
      planId: 'plan-pro',
    },
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

  // ─── Roles sistema (ROOT global + 6 roles por tenant) ──────────────────────
  await seedSystemRolesForTenant(null); // ROOT
  for (const tenantId of ['tenant-001', 'tenant-002', 'tenant-barber-001']) {
    await seedSystemRolesForTenant(tenantId);
  }
  console.log('✅ System roles');

  // ─── Users ──────────────────────────────────────────────────────────────────
  // Nota: tras migrar a Supabase, User.id mapea a auth.users.id (UUID). Los IDs
  // dev `user-00X` se mantienen aquí porque OrderItems/Payroll los referencian.
  const tenant001Roles = await prisma.role.findMany({
    where: { tenantId: 'tenant-001' },
  });
  const roleByCode = new Map(tenant001Roles.map((r) => [r.code, r.id]));

  const users = [
    {
      id: 'user-001',
      tenantId: 'tenant-001',
      email: 'diegosoft84@gmail.com',
      name: 'Diego',
      roleCode: 'OWNER',
      branches: ['branch-001', 'branch-002'],
    },
    {
      id: 'user-002',
      tenantId: 'tenant-001',
      email: 'ana@oriwok.com',
      name: 'Ana',
      roleCode: 'MANAGER',
      branches: ['branch-001'],
    },
    {
      id: 'user-003',
      tenantId: 'tenant-001',
      email: 'pedro@oriwok.com',
      name: 'Pedro',
      roleCode: 'WAITER',
      branches: ['branch-001'],
    },
    {
      id: 'user-004',
      tenantId: 'tenant-001',
      email: 'luisa@oriwok.com',
      name: 'Luisa',
      roleCode: 'KITCHEN',
      branches: ['branch-001'],
    },
    {
      id: 'user-005',
      tenantId: 'tenant-001',
      email: 'sofia@oriwok.com',
      name: 'Sofía',
      roleCode: 'CASHIER',
      branches: ['branch-001'],
    },
  ];
  for (const u of users) {
    const roleId = roleByCode.get(u.roleCode);
    if (!roleId) throw new Error(`Role ${u.roleCode} missing for tenant-001`);
    await prisma.user.upsert({
      where: { id: u.id },
      update: { roleId, passwordSetAt: new Date() },
      create: {
        id: u.id,
        tenantId: u.tenantId,
        email: u.email,
        name: u.name,
        roleId,
        passwordSetAt: new Date(), // dev users ya tienen acceso
      },
    });
    for (const branchId of u.branches) {
      await prisma.userBranch.upsert({
        where: { userId_branchId: { userId: u.id, branchId } },
        update: {},
        create: { userId: u.id, branchId },
      });
    }
  }

  const barberRoles = await prisma.role.findMany({
    where: { tenantId: 'tenant-barber-001' },
  });
  const barberRoleByCode = new Map(barberRoles.map((r) => [r.code, r.id]));
  const barberUsers = [
    {
      id: 'user-barber-owner',
      tenantId: 'tenant-barber-001',
      email: 'owner@tijerasyarte.com',
      name: 'Carlos',
      roleCode: 'OWNER',
      branches: ['branch-barber-001'],
    },
  ];
  for (const u of barberUsers) {
    const roleId = barberRoleByCode.get(u.roleCode);
    if (!roleId)
      throw new Error(`Role ${u.roleCode} missing for barber tenant`);
    await prisma.user.upsert({
      where: { id: u.id },
      update: { roleId, passwordSetAt: new Date(), isActive: true },
      create: {
        id: u.id,
        tenantId: u.tenantId,
        email: u.email,
        name: u.name,
        roleId,
        passwordSetAt: new Date(),
      },
    });
    for (const branchId of u.branches) {
      await prisma.userBranch.upsert({
        where: { userId_branchId: { userId: u.id, branchId } },
        update: {},
        create: { userId: u.id, branchId },
      });
    }
  }
  console.log('✅ Users + UserBranch');

  // ─── Platform admins (superadmins @uselynko) ──────────────────────────────────
  // Identidad de plataforma (NO rol de tenant). Se crean con `npm run bootstrap:root`
  // (requieren usuario en Supabase Auth); aquí solo aseguramos el flag de forma
  // idempotente si ya existen localmente. Ver docs/BACKOFFICE_ARCHITECTURE.md §1/§10.3.
  const PLATFORM_ADMIN_EMAILS = ['admin@uselynko.com', 'noreply@uselynko.com'];
  const flagged = await prisma.user.updateMany({
    where: { email: { in: PLATFORM_ADMIN_EMAILS } },
    data: { isPlatformAdmin: true },
  });
  console.log(
    `✅ Platform admins flagged (${flagged.count}/${PLATFORM_ADMIN_EMAILS.length} presentes; faltantes → \`npm run bootstrap:root\`)`,
  );

  // ─── Suscripciones por tenant existente ───────────────────────────────────────
  // El acceso a la app del tenant se condiciona por tenant.status + subscription.status
  // (enforcement en login). Creamos una suscripción ACTIVE/manual por cada tenant.
  const PLAN_PRICE_COP: Record<string, number> = {
    BASIC: 79000,
    PRO: 129000,
    PREMIUM: 219000,
  };
  const PLAN_PRICE_USD: Record<string, number> = {
    BASIC: 20,
    PRO: 32,
    PREMIUM: 55,
  };
  const allTenants = await prisma.tenant.findMany({
    where: { deletedAt: null },
    select: { id: true, plan: true },
  });
  const subNow = new Date();
  const subPeriodEnd = new Date(subNow);
  subPeriodEnd.setMonth(subPeriodEnd.getMonth() + 1);
  for (const t of allTenants) {
    await prisma.subscription.upsert({
      where: { tenantId: t.id },
      update: {}, // no pisar cambios manuales hechos desde el backoffice
      create: {
        tenantId: t.id,
        plan: t.plan,
        status: 'ACTIVE',
        billingCycle: 'monthly',
        currentPeriodStart: subNow,
        currentPeriodEnd: subPeriodEnd,
        priceCOP: PLAN_PRICE_COP[t.plan] ?? null,
        priceUSD: PLAN_PRICE_USD[t.plan] ?? null,
        provider: 'manual',
      },
    });
  }
  console.log(`✅ Subscriptions (${allTenants.length} tenants)`);

  // ─── Barbería demo ────────────────────────────────────────────────────────
  await prisma.barberSettings.upsert({
    where: { branchId: 'branch-barber-001' },
    update: {
      phone: '601-555-0001',
      city: 'Bogotá',
      bookingSlug: 'tijeras-y-arte',
      onlineBookingEnabled: true,
      whatsappEnabled: true,
      loyaltyEnabled: true,
      themeTemplateId: 'studio',
      themePrimaryColor: '#6366f1',
      themeAccentColor: '#22c55e',
      themeLogoMode: 'initials',
      heroTitle: 'Tijeras y Arte',
      heroDescription: 'Barbería moderna con agenda online',
    },
    create: {
      tenantId: 'tenant-barber-001',
      branchId: 'branch-barber-001',
      phone: '601-555-0001',
      city: 'Bogotá',
      bookingSlug: 'tijeras-y-arte',
      onlineBookingEnabled: true,
      whatsappEnabled: true,
      loyaltyEnabled: true,
      themeTemplateId: 'studio',
      themePrimaryColor: '#6366f1',
      themeAccentColor: '#22c55e',
      themeLogoMode: 'initials',
      heroTitle: 'Tijeras y Arte',
      heroDescription: 'Barbería moderna con agenda online',
    },
  });

  const barberServices = [
    {
      id: 'barber-service-corte',
      name: 'Corte',
      durationMin: 30,
      priceCOP: 25000,
      color: '#3b82f6',
      sortOrder: 1,
    },
    {
      id: 'barber-service-barba',
      name: 'Barba',
      durationMin: 20,
      priceCOP: 15000,
      color: '#22c55e',
      sortOrder: 2,
    },
    {
      id: 'barber-service-corte-barba',
      name: 'Corte + Barba',
      durationMin: 45,
      priceCOP: 38000,
      color: '#6366f1',
      sortOrder: 3,
    },
    {
      id: 'barber-service-cejas',
      name: 'Cejas',
      durationMin: 15,
      priceCOP: 10000,
      color: '#f59e0b',
      sortOrder: 4,
    },
    {
      id: 'barber-service-pestanas',
      name: 'Pestañas',
      durationMin: 30,
      priceCOP: 20000,
      color: '#ec4899',
      sortOrder: 5,
    },
    {
      id: 'barber-service-capilar',
      name: 'Tratamiento capilar',
      durationMin: 60,
      priceCOP: 45000,
      color: '#8b5cf6',
      sortOrder: 6,
    },
  ];
  for (const service of barberServices) {
    await prisma.barberService.upsert({
      where: { id: service.id },
      update: {
        name: service.name,
        durationMin: service.durationMin,
        priceCOP: service.priceCOP,
        color: service.color,
        sortOrder: service.sortOrder,
        isActive: true,
      },
      create: {
        ...service,
        tenantId: 'tenant-barber-001',
        branchId: 'branch-barber-001',
      },
    });
  }

  const barberStaff = [
    {
      id: 'barber-staff-carlos',
      name: 'Carlos',
      phone: '3005550001',
      color: '#6366f1',
      sortOrder: 1,
    },
    {
      id: 'barber-staff-mateo',
      name: 'Mateo',
      phone: '3005550002',
      color: '#22c55e',
      sortOrder: 2,
    },
    {
      id: 'barber-staff-laura',
      name: 'Laura',
      phone: '3005550003',
      color: '#ec4899',
      sortOrder: 3,
    },
  ];
  for (const staff of barberStaff) {
    await prisma.barberStaff.upsert({
      where: { id: staff.id },
      update: {
        name: staff.name,
        phone: staff.phone,
        color: staff.color,
        sortOrder: staff.sortOrder,
        isActive: true,
      },
      create: {
        ...staff,
        tenantId: 'tenant-barber-001',
        branchId: 'branch-barber-001',
      },
    });
  }

  for (const staff of barberStaff) {
    for (const service of barberServices) {
      await prisma.barberStaffService.upsert({
        where: {
          staffId_serviceId: {
            staffId: staff.id,
            serviceId: service.id,
          },
        },
        update: {},
        create: { staffId: staff.id, serviceId: service.id },
      });
    }
  }

  const barberCustomers = [
    {
      id: 'barber-customer-juan',
      name: 'Juan Pérez',
      phone: '3105550101',
      tags: ['frecuente'],
    },
    {
      id: 'barber-customer-andres',
      name: 'Andrés Gómez',
      phone: '3105550102',
      tags: ['barba'],
    },
    {
      id: 'barber-customer-maria',
      name: 'María Torres',
      phone: '3105550103',
      tags: ['color'],
    },
  ];
  for (const customer of barberCustomers) {
    await prisma.barberCustomer.upsert({
      where: { id: customer.id },
      update: {
        name: customer.name,
        phone: customer.phone,
        tags: customer.tags,
        isActive: true,
      },
      create: {
        ...customer,
        tenantId: 'tenant-barber-001',
        branchId: 'branch-barber-001',
      },
    });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const appointmentBase = new Date(today.getTime() + 10 * 60 * 60 * 1000);
  const barberAppointments = [
    {
      id: 'barber-appointment-001',
      customerId: 'barber-customer-juan',
      serviceId: 'barber-service-corte',
      staffId: 'barber-staff-carlos',
      hourOffset: 0,
    },
    {
      id: 'barber-appointment-002',
      customerId: 'barber-customer-andres',
      serviceId: 'barber-service-corte-barba',
      staffId: 'barber-staff-mateo',
      hourOffset: 2,
    },
    {
      id: 'barber-appointment-003',
      customerId: 'barber-customer-maria',
      serviceId: 'barber-service-capilar',
      staffId: 'barber-staff-laura',
      hourOffset: 4,
    },
  ];
  for (const appointment of barberAppointments) {
    const service = barberServices.find((s) => s.id === appointment.serviceId);
    if (!service) throw new Error(`Service missing ${appointment.serviceId}`);
    const scheduledAt = new Date(
      appointmentBase.getTime() + appointment.hourOffset * 60 * 60 * 1000,
    );
    const scheduledEnd = new Date(
      scheduledAt.getTime() + service.durationMin * 60_000,
    );
    await prisma.barberAppointment.upsert({
      where: { id: appointment.id },
      update: {
        customerId: appointment.customerId,
        serviceId: appointment.serviceId,
        staffId: appointment.staffId,
        scheduledAt,
        scheduledEnd,
        status: 'SCHEDULED',
      },
      create: {
        id: appointment.id,
        tenantId: 'tenant-barber-001',
        branchId: 'branch-barber-001',
        customerId: appointment.customerId,
        serviceId: appointment.serviceId,
        staffId: appointment.staffId,
        scheduledAt,
        scheduledEnd,
        status: 'SCHEDULED',
      },
    });
  }
  console.log('✅ Barber settings + demo data');

  // ─── Product Categories ──────────────────────────────────────────────────────
  const categories = [
    {
      id: 'cat-001',
      tenantId: 'tenant-001',
      name: 'Entradas',
      emoji: '🥗',
      sortOrder: 1,
    },
    {
      id: 'cat-002',
      tenantId: 'tenant-001',
      name: 'Platos',
      emoji: '🍽️',
      sortOrder: 2,
    },
    {
      id: 'cat-003',
      tenantId: 'tenant-001',
      name: 'Bebidas',
      emoji: '🥤',
      sortOrder: 3,
    },
    {
      id: 'cat-004',
      tenantId: 'tenant-001',
      name: 'Postres',
      emoji: '🍮',
      sortOrder: 4,
    },
  ];
  for (const cat of categories) {
    await prisma.productCategory.upsert({
      where: { id: cat.id },
      update: {},
      create: cat,
    });
  }
  console.log('✅ Categories');

  // ─── Products ───────────────────────────────────────────────────────────────
  const products = [
    {
      id: 'm1',
      tenantId: 'tenant-001',
      categoryId: 'cat-001',
      name: 'Empanadas x3',
      description: 'Rellenas de carne molida',
      priceCOP: 12000,
      emoji: '🥟',
      isAvailable: true,
      sortOrder: 1,
    },
    {
      id: 'm2',
      tenantId: 'tenant-001',
      categoryId: 'cat-001',
      name: 'Patacones',
      priceCOP: 10000,
      emoji: '🫓',
      isAvailable: true,
      sortOrder: 2,
    },
    {
      id: 'm3',
      tenantId: 'tenant-001',
      categoryId: 'cat-001',
      name: 'Ceviche',
      priceCOP: 18000,
      emoji: '🍤',
      isAvailable: true,
      sortOrder: 3,
    },
    {
      id: 'm4',
      tenantId: 'tenant-001',
      categoryId: 'cat-001',
      name: 'Yuca frita',
      priceCOP: 9000,
      emoji: '🍟',
      isAvailable: true,
      sortOrder: 4,
    },
    {
      id: 'm5',
      tenantId: 'tenant-001',
      categoryId: 'cat-002',
      name: 'Bandeja Paisa',
      description: 'Plato típico colombiano completo',
      priceCOP: 28000,
      emoji: '🍛',
      isAvailable: true,
      sortOrder: 1,
    },
    {
      id: 'm6',
      tenantId: 'tenant-001',
      categoryId: 'cat-002',
      name: 'Ajiaco',
      priceCOP: 22000,
      emoji: '🥘',
      isAvailable: true,
      sortOrder: 2,
    },
    {
      id: 'm7',
      tenantId: 'tenant-001',
      categoryId: 'cat-002',
      name: 'Churrasco',
      priceCOP: 35000,
      emoji: '🥩',
      isAvailable: true,
      sortOrder: 3,
    },
    {
      id: 'm8',
      tenantId: 'tenant-001',
      categoryId: 'cat-002',
      name: 'Pollo al limón',
      priceCOP: 26000,
      emoji: '🍗',
      isAvailable: false,
      sortOrder: 4,
    },
    {
      id: 'm9',
      tenantId: 'tenant-001',
      categoryId: 'cat-003',
      name: 'Limonada',
      priceCOP: 8000,
      emoji: '🍋',
      isAvailable: true,
      sortOrder: 1,
    },
    {
      id: 'm10',
      tenantId: 'tenant-001',
      categoryId: 'cat-003',
      name: 'Jugo Natural',
      priceCOP: 9000,
      emoji: '🧃',
      isAvailable: true,
      sortOrder: 2,
    },
    {
      id: 'm11',
      tenantId: 'tenant-001',
      categoryId: 'cat-003',
      name: 'Gaseosa',
      priceCOP: 5000,
      emoji: '🥤',
      isAvailable: true,
      sortOrder: 3,
    },
    {
      id: 'm12',
      tenantId: 'tenant-001',
      categoryId: 'cat-003',
      name: 'Agua',
      priceCOP: 4000,
      emoji: '💧',
      isAvailable: true,
      sortOrder: 4,
    },
    {
      id: 'm13',
      tenantId: 'tenant-001',
      categoryId: 'cat-004',
      name: 'Tres Leches',
      priceCOP: 14000,
      emoji: '🍰',
      isAvailable: true,
      sortOrder: 1,
    },
    {
      id: 'm14',
      tenantId: 'tenant-001',
      categoryId: 'cat-004',
      name: 'Natilla',
      priceCOP: 12000,
      emoji: '🍮',
      isAvailable: true,
      sortOrder: 2,
    },
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
    {
      id: 'area-main',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      name: 'Main Hall',
      emoji: '🍽️',
    },
    {
      id: 'area-terraza',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      name: 'Terraza',
      emoji: '🌿',
    },
    {
      id: 'area-bar',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      name: 'Bar',
      emoji: '🍹',
    },
  ];
  for (const area of areas) {
    await prisma.area.upsert({
      where: { id: area.id },
      update: {},
      create: area,
    });
  }
  console.log('✅ Areas');

  // ─── Restaurant Tables ───────────────────────────────────────────────────────
  const tables = [
    {
      id: 't1',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      areaId: 'area-main',
      code: 'T-01',
      seats: 4,
      shape: 'ROUND',
      status: 'RESERVED',
    },
    {
      id: 't2',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      areaId: 'area-main',
      code: 'T-02',
      seats: 4,
      shape: 'SQUARE',
      status: 'PREPARING',
    },
    {
      id: 't3',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      areaId: 'area-main',
      code: 'T-03',
      seats: 6,
      shape: 'RECTANGLE',
      status: 'PAYMENT',
    },
    {
      id: 't4',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      areaId: 'area-main',
      code: 'T-04',
      seats: 4,
      shape: 'SQUARE',
      status: 'CLOSED',
    },
    {
      id: 't5',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      areaId: 'area-terraza',
      code: 'T-05',
      seats: 4,
      shape: 'SQUARE',
      status: 'PREPARING',
    },
    {
      id: 't6',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      areaId: 'area-terraza',
      code: 'T-06',
      seats: 4,
      shape: 'ROUND',
      status: 'RESERVED',
    },
    {
      id: 't7',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      areaId: 'area-bar',
      code: 'T-07',
      seats: 2,
      shape: 'SQUARE',
      status: 'AVAILABLE',
    },
    {
      id: 't8',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      areaId: 'area-bar',
      code: 'T-08',
      seats: 2,
      shape: 'SQUARE',
      status: 'AVAILABLE',
    },
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
    {
      id: 'oi-001',
      orderId: 'ORD-001',
      productId: 'm5',
      name: 'Bandeja Paisa',
      priceCOP: 28000,
      qty: 3,
      sentQty: 3,
    },
    {
      id: 'oi-002',
      orderId: 'ORD-001',
      productId: 'm11',
      name: 'Gaseosa',
      priceCOP: 5000,
      qty: 3,
      sentQty: 3,
    },
    {
      id: 'oi-003',
      orderId: 'ORD-001',
      productId: 'm1',
      name: 'Empanadas x3',
      priceCOP: 12000,
      qty: 2,
      sentQty: 2,
    },
    // ORD-002: Ajiaco×1 + Limonada×1 + Natilla×1
    {
      id: 'oi-004',
      orderId: 'ORD-002',
      productId: 'm6',
      name: 'Ajiaco',
      priceCOP: 22000,
      qty: 1,
      sentQty: 1,
    },
    {
      id: 'oi-005',
      orderId: 'ORD-002',
      productId: 'm9',
      name: 'Limonada',
      priceCOP: 8000,
      qty: 1,
      sentQty: 1,
    },
    {
      id: 'oi-006',
      orderId: 'ORD-002',
      productId: 'm14',
      name: 'Natilla',
      priceCOP: 12000,
      qty: 1,
      sentQty: 1,
    },
    // ORD-003: Churrasco×2 + Jugo Natural×2
    {
      id: 'oi-007',
      orderId: 'ORD-003',
      productId: 'm7',
      name: 'Churrasco',
      priceCOP: 35000,
      qty: 2,
      sentQty: 2,
    },
    {
      id: 'oi-008',
      orderId: 'ORD-003',
      productId: 'm10',
      name: 'Jugo Natural',
      priceCOP: 9000,
      qty: 2,
      sentQty: 2,
    },
  ];
  for (const item of orderItems) {
    await prisma.orderItem.upsert({
      where: { id: item.id },
      update: {},
      create: item,
    });
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
    {
      id: 'kti-001',
      ticketId: 'KS-001',
      productId: 'm5',
      name: 'Bandeja Paisa',
      qty: 3,
    },
    {
      id: 'kti-002',
      ticketId: 'KS-001',
      productId: 'm11',
      name: 'Gaseosa',
      qty: 3,
    },
    {
      id: 'kti-003',
      ticketId: 'KS-001',
      productId: 'm1',
      name: 'Empanadas x3',
      qty: 2,
    },
    {
      id: 'kti-004',
      ticketId: 'KS-002',
      productId: 'm6',
      name: 'Ajiaco',
      qty: 1,
    },
    {
      id: 'kti-005',
      ticketId: 'KS-002',
      productId: 'm14',
      name: 'Natilla',
      qty: 1,
    },
    {
      id: 'kti-006',
      ticketId: 'KS-003',
      productId: 'm7',
      name: 'Churrasco',
      qty: 2,
    },
    {
      id: 'kti-007',
      ticketId: 'KS-003',
      productId: 'm10',
      name: 'Jugo Natural',
      qty: 2,
    },
  ];
  for (const ki of kitchenItems) {
    await prisma.kitchenTicketItem.upsert({
      where: { id: ki.id },
      update: {},
      create: ki,
    });
  }
  console.log('✅ Kitchen Tickets');

  // ─── Reservations ────────────────────────────────────────────────────────────
  const reservations = [
    {
      id: 'res-001',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      tableId: 't1',
      guestName: 'Familia Gómez',
      guestPhone: '+573001112233',
      partySize: 4,
      scheduledAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
      scheduledEnd: new Date(now.getTime() + 4 * 60 * 60 * 1000),
      occasion: 'birthday',
      occasionNote: 'Cumpleaños 40',
      status: 'ACTIVE',
    },
    {
      id: 'res-002',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      tableId: 't6',
      guestName: 'Daniel y Laura',
      guestPhone: '+573014445566',
      partySize: 2,
      scheduledAt: new Date(now.getTime() + 5 * 60 * 60 * 1000),
      occasion: 'anniversary',
      status: 'ACTIVE',
    },
  ];
  for (const res of reservations) {
    await prisma.reservation.upsert({
      where: { id: res.id },
      update: {},
      create: res,
    });
  }
  console.log('✅ Reservations');

  // ─── Expenses ────────────────────────────────────────────────────────────────
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const expenses = [
    {
      id: 'exp-001',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      category: 'rent',
      concept: 'Arriendo local',
      amountCOP: 3_500_000,
      incurredAt: new Date(monthStart.getTime() + 24 * 60 * 60 * 1000),
    },
    {
      id: 'exp-002',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      category: 'utilities',
      concept: 'Energía + Agua',
      amountCOP: 420_000,
      incurredAt: new Date(monthStart.getTime() + 5 * 24 * 60 * 60 * 1000),
    },
    {
      id: 'exp-003',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      category: 'supplies',
      concept: 'Insumos cocina',
      amountCOP: 1_200_000,
      incurredAt: new Date(monthStart.getTime() + 8 * 24 * 60 * 60 * 1000),
    },
    {
      id: 'exp-004',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      category: 'marketing',
      concept: 'Campaña IG Ads',
      amountCOP: 300_000,
      incurredAt: new Date(monthStart.getTime() + 12 * 24 * 60 * 60 * 1000),
    },
  ];
  for (const exp of expenses) {
    await prisma.expense.upsert({
      where: { id: exp.id },
      update: {},
      create: exp,
    });
  }
  console.log('✅ Expenses');

  // ─── Payroll ─────────────────────────────────────────────────────────────────
  const periodMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const payrolls = [
    {
      id: 'pay-001',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      userId: 'user-002',
      staffName: 'Ana',
      role: 'MANAGER',
      periodMonth,
      grossCOP: 3_200_000,
      netCOP: 2_880_000,
      paidAt: monthStart,
    },
    {
      id: 'pay-002',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      userId: 'user-003',
      staffName: 'Pedro',
      role: 'WAITER',
      periodMonth,
      grossCOP: 1_600_000,
      netCOP: 1_440_000,
      paidAt: monthStart,
    },
    {
      id: 'pay-003',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      userId: 'user-004',
      staffName: 'Luisa',
      role: 'KITCHEN',
      periodMonth,
      grossCOP: 1_800_000,
      netCOP: 1_620_000,
      paidAt: monthStart,
    },
    {
      id: 'pay-004',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      userId: 'user-005',
      staffName: 'Sofía',
      role: 'CASHIER',
      periodMonth,
      grossCOP: 1_500_000,
      netCOP: 1_350_000,
      paidAt: monthStart,
    },
  ];
  for (const p of payrolls) {
    await prisma.payroll.upsert({ where: { id: p.id }, update: {}, create: p });
  }
  console.log('✅ Payroll');

  // ─── Finance Goals ───────────────────────────────────────────────────────────
  const goals = [
    {
      id: 'goal-001',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      periodMonth,
      metric: 'revenue',
      targetCOP: 25_000_000,
    },
    {
      id: 'goal-002',
      tenantId: 'tenant-001',
      branchId: 'branch-001',
      periodMonth,
      metric: 'profit',
      targetCOP: 8_000_000,
    },
  ];
  for (const g of goals) {
    await prisma.financeGoal.upsert({
      where: { id: g.id },
      update: {},
      create: g,
    });
  }
  console.log('✅ Finance Goals');

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
