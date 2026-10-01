import { config } from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Tenants de demostración para grabar videos y hacer demos: uno por vertical.
 *
 *   Restaurante Demo 1 · Barbería Demo 1 · Tienda Demo 1
 *
 * DE DÓNDE SALE. No se copia ningún registro real. Se perfiló la réplica local
 * (solo agregados) y los números de abajo imitan esa forma: el restaurante es
 * comida rápida de noche con ticket ~$50k, ~18 órdenes/día, 3 ítems por orden y
 * costo ~46%; la tienda vende ~1,5 ítems por venta con abonos y algún mayoreo;
 * la barbería mezcla cortes de 30 min con servicios largos. Todo lo que es una
 * persona se llama "… Demo N" a propósito: que nadie lo confunda con un cliente.
 *
 * SOLO LOCAL. Se niega a correr si DATABASE_URL no apunta a localhost. Lee
 * `.env.local` primero (como el backend), porque `.env` apunta a producción.
 *
 * LOGIN. Aunque la base sea local, el login pasa por Supabase Auth de
 * producción. Cada dueño demo necesita su usuario allí:
 *   - sin flags: busca el usuario por email y aborta si falta;
 *   - --create-auth --password <clave>: lo crea (o le fija la clave) en Auth.
 *     Solo toca Auth, ninguna tabla de producción.
 *
 * Idempotente: borra todo lo de los tres tenants demo y lo vuelve a sembrar.
 * Correr `db-replica.sh` los borra; basta con volver a correr esto.
 *
 * Uso:
 *   npx ts-node scripts/seed-demo-showcase.ts
 *   npx ts-node scripts/seed-demo-showcase.ts --create-auth --password 'Demo2026!'
 *   npx ts-node scripts/seed-demo-showcase.ts --only retail --days 45
 */

config({ path: '.env.local' });
config({ path: '.env' }); // no pisa lo que ya puso .env.local

// ─── Args ─────────────────────────────────────────────────────────────────────

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

const CREATE_AUTH = process.argv.includes('--create-auth');
const PASSWORD = arg('--password') ?? process.env.DEMO_PASSWORD;
const DAYS = Number(arg('--days') ?? 60);
const ONLY = arg('--only') as 'restaurant' | 'barber' | 'retail' | undefined;

// ─── Guard: solo réplica local ───────────────────────────────────────────────

function assertLocalDatabase() {
  const url = process.env.DATABASE_URL ?? '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* host vacío → falla abajo */
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(
      `DATABASE_URL apunta a "${host || '(vacío)'}". Este seed solo corre contra la réplica local.`,
    );
  }
}

// ─── Definición de los tenants demo ──────────────────────────────────────────

const DEMO = {
  restaurant: {
    vertical: 'vertical-restaurant',
    referenceTenantId: 'tenant-fab841ba', // de aquí salen roles y permisos
    tenantId: 'tenant-demo-restaurant-1',
    branchId: 'branch-demo-restaurant-1',
    name: 'Restaurante Demo 1',
    plan: 'PRO',
    ownerEmail: 'demo.restaurante1@uselynko.com',
    ownerName: 'Dueño Demo 1',
  },
  barber: {
    vertical: 'vertical-barber',
    referenceTenantId: 'tenant-e2593413',
    tenantId: 'tenant-demo-barber-1',
    branchId: 'branch-demo-barber-1',
    name: 'Barbería Demo 1',
    plan: 'PRO',
    ownerEmail: 'demo.barberia1@uselynko.com',
    ownerName: 'Dueño Demo 1',
  },
  retail: {
    vertical: 'vertical-retail',
    referenceTenantId: 'tenant-caf2c28e',
    tenantId: 'tenant-demo-retail-1',
    branchId: 'branch-demo-retail-1',
    name: 'Tienda Demo 1',
    plan: 'PREMIUM',
    ownerEmail: 'demo.tienda1@uselynko.com',
    ownerName: 'Dueña Demo 1',
  },
} as const;

type DemoKey = keyof typeof DEMO;
type DemoDef = (typeof DEMO)[DemoKey];

const prisma = new PrismaClient();

// ─── Aleatorio determinista ──────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rand = mulberry32(20261001);
const between = (min: number, max: number) => min + rand() * (max - min);
const int = (min: number, max: number) => Math.floor(between(min, max + 1));
const chance = (p: number) => rand() < p;
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
function weighted<T extends { weight: number }>(xs: readonly T[]): T {
  const total = xs.reduce((s, x) => s + x.weight, 0);
  let r = rand() * total;
  for (const x of xs) {
    r -= x.weight;
    if (r <= 0) return x;
  }
  return xs[xs.length - 1];
}
const roundTo = (n: number, step: number) => Math.round(n / step) * step;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

// ─── Fechas en hora Colombia (UTC-5, sin horario de verano) ──────────────────

const CO_OFFSET_MS = 5 * 60 * 60_000;
const NOW = new Date();

/** Fecha calendario de hoy en Colombia, como UTC a medianoche. */
function todayCO(): Date {
  const local = new Date(NOW.getTime() - CO_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

/** Instante para `daysAgo` días atrás a la hora local `hour:minute` (hour puede pasar de 24). */
function atCO(daysAgo: number, hour: number, minute = 0): Date {
  const day = todayCO().getTime() - daysAgo * 86_400_000;
  return new Date(day + (hour * 60 + minute) * 60_000 + CO_OFFSET_MS);
}

/** 0 = domingo … 6 = sábado, del día local `daysAgo`. */
function weekdayCO(daysAgo: number): number {
  return new Date(todayCO().getTime() - daysAgo * 86_400_000).getUTCDay();
}

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const addMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

/** Crece suave a lo largo del periodo: los gráficos muestran tendencia al alza. */
const trend = (daysAgo: number) => 0.85 + 0.3 * (1 - daysAgo / DAYS);

// ─── Supabase Auth (producción, solo usuarios) ───────────────────────────────

let supabase: SupabaseClient | null = null;
function auth(): SupabaseClient {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env');
  supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return supabase;
}

async function findAuthUserId(email: string): Promise<string | null> {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await auth().auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Supabase listUsers: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 1000) return null;
  }
  return null;
}

async function resolveOwnerAuthId(def: DemoDef, roleId: string): Promise<string> {
  const appMetadata = { tenantId: def.tenantId, roleId };
  const existing = await findAuthUserId(def.ownerEmail);

  if (!CREATE_AUTH) {
    if (!existing) {
      throw new Error(
        `${def.ownerEmail} no existe en Supabase Auth. Corre con --create-auth --password <clave>.`,
      );
    }
    return existing;
  }

  if (!PASSWORD) throw new Error('--create-auth necesita --password <clave> (o DEMO_PASSWORD).');

  if (existing) {
    const { error } = await auth().auth.admin.updateUserById(existing, {
      password: PASSWORD,
      app_metadata: appMetadata,
    });
    if (error) throw new Error(`Supabase updateUser ${def.ownerEmail}: ${error.message}`);
    return existing;
  }

  const { data, error } = await auth().auth.admin.createUser({
    email: def.ownerEmail,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: appMetadata,
  });
  if (error || !data.user) throw new Error(`Supabase createUser ${def.ownerEmail}: ${error?.message}`);
  console.log(`  ✓ Auth creado: ${def.ownerEmail}`);
  return data.user.id;
}

// ─── Base común: borrar, tenant, roles, dueño ────────────────────────────────

/**
 * Borra todo lo del tenant. Recorre cada tabla con columna "tenantId" y repite
 * hasta que no queden filas: así no hay que mantener a mano el orden de FKs, y
 * también se va lo que la app haya escrito durante una demo (eventos, logs…).
 */
async function wipeTenant(tenantId: string) {
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenantId'`;

  for (let pass = 0; pass < 10; pass++) {
    let blocked = 0;
    for (const { table_name } of tables) {
      try {
        await prisma.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "tenantId" = $1`, tenantId);
      } catch {
        blocked++; // FK: otra tabla todavía la referencia, cae en la siguiente pasada
      }
    }
    if (blocked === 0) break;
    if (pass === 9) throw new Error(`No se pudo limpiar ${tenantId}: quedan referencias cruzadas.`);
  }
  await prisma.$executeRawUnsafe(`DELETE FROM "tenants" WHERE "id" = $1`, tenantId);
}

async function seedBase(def: DemoDef) {
  await wipeTenant(def.tenantId);

  const periodStart = todayCO();
  const periodEnd = new Date(periodStart);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);

  await prisma.tenant.create({
    data: {
      id: def.tenantId,
      name: def.name,
      plan: def.plan,
      verticalId: def.vertical,
      status: 'ACTIVE',
      createdAt: atCO(DAYS + 5, 10),
      branches: {
        create: {
          id: def.branchId,
          name: 'Sede Principal',
          address: 'Calle Demo # 1-23, Bogotá',
          phone: '3000000000',
        },
      },
      subscription: {
        create: {
          plan: def.plan,
          status: 'ACTIVE',
          billingCycle: 'monthly',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          nextPaymentDueAt: periodEnd,
          provider: 'manual',
        },
      },
    },
  });

  // Roles y permisos idénticos a un cliente real de la misma vertical: son solo
  // códigos, y así la demo ve exactamente los menús que vería ese cliente.
  const refRoles = await prisma.role.findMany({
    where: { tenantId: def.referenceTenantId },
    include: { rolePermissions: { select: { permissionId: true } } },
  });
  if (refRoles.length === 0) {
    throw new Error(`El tenant de referencia ${def.referenceTenantId} no tiene roles en la réplica.`);
  }
  const roleIds: Record<string, string> = {};
  for (const r of refRoles) {
    const id = `${def.tenantId}-role-${r.code.toLowerCase()}`;
    roleIds[r.code] = id;
    await prisma.role.create({
      data: {
        id,
        tenantId: def.tenantId,
        code: r.code,
        name: r.name,
        isSystem: r.isSystem,
        rolePermissions: { create: r.rolePermissions.map((p) => ({ permissionId: p.permissionId })) },
      },
    });
  }
  if (!roleIds.OWNER) throw new Error(`${def.referenceTenantId} no tiene rol OWNER.`);

  const ownerId = await resolveOwnerAuthId(def, roleIds.OWNER);
  // El email es único en `users`: si quedó de otro tenant (no debería), se suelta.
  await prisma.user.deleteMany({ where: { email: def.ownerEmail, NOT: { tenantId: def.tenantId } } });
  await prisma.user.create({
    data: {
      id: ownerId,
      tenantId: def.tenantId,
      email: def.ownerEmail,
      name: def.ownerName,
      roleId: roleIds.OWNER,
      passwordSetAt: atCO(DAYS + 5, 10),
      userBranches: { create: { branchId: def.branchId } },
    },
  });

  return { ownerId, roleIds };
}

/** Usuarios que no inician sesión (meseros): existen para firmar las órdenes. */
async function seedStaffUser(def: DemoDef, roleId: string, n: number, label: string) {
  const id = `${def.tenantId}-user-${label.toLowerCase()}-${n}`;
  await prisma.user.create({
    data: {
      id,
      tenantId: def.tenantId,
      email: `${label.toLowerCase()}${n}@${def.tenantId}.demo.local`,
      name: `${label} Demo ${n}`,
      roleId,
      userBranches: { create: { branchId: def.branchId } },
    },
  });
  return id;
}

type ExpenseSeed = {
  category: string;
  concept: string;
  amountCOP: number;
  dayOfMonth?: number;
  everyDays?: number;
  jitter?: number;
};

async function seedExpenses(def: DemoDef, rows: ExpenseSeed[]) {
  const data: Prisma.ExpenseCreateManyInput[] = [];
  for (const r of rows) {
    for (let d = DAYS; d >= 0; d--) {
      const date = new Date(todayCO().getTime() - d * 86_400_000);
      const monthly = r.dayOfMonth !== undefined && date.getUTCDate() === r.dayOfMonth;
      const periodic = r.everyDays !== undefined && d % r.everyDays === 0;
      if (!monthly && !periodic) continue;
      const amount = r.jitter ? roundTo(r.amountCOP * between(1 - r.jitter, 1 + r.jitter), 1000) : r.amountCOP;
      data.push({
        tenantId: def.tenantId,
        branchId: def.branchId,
        category: r.category,
        concept: r.concept,
        amountCOP: amount,
        incurredAt: atCO(d, 10),
        frequency: monthly ? 'MONTHLY' : 'ONE_TIME',
        isRecurring: monthly,
      });
    }
  }
  await prisma.expense.createMany({ data });
  return data.length;
}

// ─── Restaurante ─────────────────────────────────────────────────────────────

const MENU: { cat: string; emoji: string; items: [string, number, number][] }[] = [
  // [nombre, precio, peso de popularidad]
  { cat: 'Hamburguesas', emoji: '🍔', items: [['Hamburguesa clásica', 16000, 10], ['Hamburguesa doble carne', 22000, 7], ['Hamburguesa pollo crispy', 19000, 6], ['Hamburguesa BBQ tocineta', 21000, 6], ['Hamburguesa mexicana', 20000, 4], ['Hamburguesa hawaiana', 18000, 3]] },
  { cat: 'Perros', emoji: '🌭', items: [['Perro sencillo', 13000, 5], ['Perro especial', 16000, 5], ['Perro ranchero', 17000, 3]] },
  { cat: 'Salchipapas', emoji: '🍟', items: [['Salchipapa sencilla', 16000, 6], ['Salchipapa de la casa', 25000, 5]] },
  { cat: 'Grill', emoji: '🥩', items: [['Churrasco 300 g', 32000, 3], ['Pechuga a la plancha', 26000, 3], ['Costillas BBQ', 34000, 2]] },
  { cat: 'Mazorcadas', emoji: '🌽', items: [['Mazorcada mixta', 25000, 3]] },
  { cat: 'Tacos', emoji: '🌮', items: [['Tacos al pastor x3', 22000, 3]] },
  { cat: 'Limonadas', emoji: '🍋', items: [['Limonada natural', 8000, 6], ['Limonada de coco', 12000, 5], ['Limonada cerezada', 11000, 3]] },
  { cat: 'Bebidas', emoji: '🥤', items: [['Gaseosa 400 ml', 4000, 9], ['Agua sin gas', 3000, 3], ['Jugo natural', 7000, 5], ['Té helado', 5000, 3]] },
  { cat: 'Cervezas', emoji: '🍺', items: [['Cerveza nacional', 6000, 6], ['Cerveza artesanal', 11000, 2]] },
  { cat: 'Adiciones', emoji: '➕', items: [['Porción de papas', 5000, 4], ['Queso extra', 3000, 3], ['Tocineta extra', 4000, 3]] },
];
const MAIN_CATS = new Set(['Hamburguesas', 'Perros', 'Salchipapas', 'Grill', 'Mazorcadas', 'Tacos']);
const DRINK_CATS = new Set(['Limonadas', 'Bebidas', 'Cervezas']);

/** Ocupación por día de la semana (0 = domingo): comida rápida de noche. */
const REST_DOW = [1.1, 0.6, 0.7, 0.8, 0.95, 1.4, 1.6];

async function seedRestaurant() {
  const def = DEMO.restaurant;
  console.log(`→ ${def.name}`);
  const { ownerId, roleIds } = await seedBase(def);
  const t = { tenantId: def.tenantId, branchId: def.branchId };

  const waiterRole = roleIds.WAITER ?? roleIds.OWNER;
  const waiters = [
    await seedStaffUser(def, waiterRole, 1, 'Mesero'),
    await seedStaffUser(def, waiterRole, 2, 'Mesero'),
    await seedStaffUser(def, waiterRole, 3, 'Mesero'),
  ];

  // Carta
  type P = { id: string; name: string; price: number; cost: number; cat: string; weight: number };
  const products: P[] = [];
  for (const [ci, c] of MENU.entries()) {
    const categoryId = `${def.tenantId}-cat-${ci}`;
    await prisma.productCategory.create({
      data: { id: categoryId, ...t, name: c.cat, emoji: c.emoji, sortOrder: ci },
    });
    for (const [pi, [name, price, weight]] of c.items.entries()) {
      const id = `${def.tenantId}-prod-${ci}-${pi}`;
      const cost = roundTo(price * between(0.38, 0.52), 100);
      products.push({ id, name, price, cost, cat: c.cat, weight });
      await prisma.product.create({
        data: { id, ...t, categoryId, name, priceCOP: price, emoji: c.emoji, sortOrder: pi },
      });
    }
  }
  const mains = products.filter((p) => MAIN_CATS.has(p.cat));
  const drinks = products.filter((p) => DRINK_CATS.has(p.cat));
  const extras = products.filter((p) => p.cat === 'Adiciones');

  // Salón
  const AREAS: { name: string; emoji: string; tables: { code: string; seats: number; shape: string }[] }[] = [
    { name: 'Salón', emoji: '🍽️', tables: Array.from({ length: 8 }, (_, i) => ({ code: `M-${i + 1}`, seats: 4, shape: i < 5 ? 'RECTANGLE' : 'ROUND' })) },
    { name: 'Terraza', emoji: '🌙', tables: Array.from({ length: 4 }, (_, i) => ({ code: `T-0${i + 1}`, seats: 4, shape: 'ROUND' })) },
    { name: 'Barra', emoji: '🍺', tables: Array.from({ length: 3 }, (_, i) => ({ code: `B-${i + 1}`, seats: 1, shape: 'SQUARE' })) },
    { name: 'Domicilios', emoji: '🛵', tables: Array.from({ length: 4 }, (_, i) => ({ code: `D-${i + 1}`, seats: 4, shape: 'SQUARE' })) },
  ];
  const tables: { id: string; code: string; seats: number }[] = [];
  for (const [ai, a] of AREAS.entries()) {
    const areaId = `${def.tenantId}-area-${ai}`;
    await prisma.area.create({ data: { id: areaId, ...t, name: a.name, emoji: a.emoji } });
    for (const tb of a.tables) {
      const id = `${def.tenantId}-table-${tb.code}`;
      tables.push({ id, code: tb.code, seats: tb.seats });
      await prisma.restaurantTable.create({ data: { id, ...t, areaId, code: tb.code, seats: tb.seats, shape: tb.shape } });
    }
  }

  // Comanda: un plato fuerte por persona, bebida casi siempre, adición a veces.
  function buildOrderLines(people: number) {
    const lines = new Map<string, { p: P; qty: number }>();
    const add = (p: P) => {
      const cur = lines.get(p.id);
      if (cur) cur.qty++;
      else lines.set(p.id, { p, qty: 1 });
    };
    for (let i = 0; i < people; i++) {
      add(weighted(mains));
      if (chance(0.75)) add(weighted(drinks));
      if (chance(0.2)) add(weighted(extras));
    }
    return [...lines.values()];
  }

  const TERMINAL = `api-terminal:${def.branchId}`;
  const orders: Prisma.OrderCreateManyInput[] = [];
  const items: Prisma.OrderItemCreateManyInput[] = [];
  const splits: Prisma.PaymentSplitCreateManyInput[] = [];
  const contribs: Prisma.PaymentContributionCreateManyInput[] = [];
  const splitItems: Prisma.PaymentSplitItemCreateManyInput[] = [];
  const todaySales: { orderId: string; method: string; amount: number; at: Date }[] = [];
  let seq = 0;

  const nowLocalHour = (NOW.getTime() - CO_OFFSET_MS) / 3_600_000 % 24;

  for (let d = DAYS; d >= 0; d--) {
    let count = Math.round(17 * REST_DOW[weekdayCO(d)] * trend(d) * between(0.85, 1.15));
    // Hoy: solo lo que ya pasó, con almuerzo para que "ventas de hoy" no quede en cero de día.
    let hourRange: [number, number] = [18, 25];
    if (d === 0) {
      if (nowLocalHour < 12.5) count = 0;
      else {
        hourRange = [12, Math.min(nowLocalHour - 0.5, 25)];
        count = Math.max(4, Math.round(count * (hourRange[1] - hourRange[0]) / 9));
      }
    }
    for (let k = 0; k < count; k++) {
      const id = `${def.tenantId}-ord-${pad(++seq, 5)}`;
      const opened = atCO(d, 0, Math.floor(between(hourRange[0], hourRange[1]) * 60));
      const closed = addMin(opened, int(25, 70));
      const table = pick(tables);
      const lines = buildOrderLines(Math.min(table.seats, weighted([{ n: 1, weight: 3 }, { n: 2, weight: 4 }, { n: 3, weight: 2 }, { n: 4, weight: 2 }]).n));
      const total = lines.reduce((s, l) => s + l.p.price * l.qty, 0);
      const cost = lines.reduce((s, l) => s + l.p.cost * l.qty, 0);

      orders.push({ id, ...t, tableId: table.id, terminalId: TERMINAL, waiterId: pick(waiters), status: 'CLOSED', totalCOP: total, costCOP: cost, createdAt: opened, closedAt: closed });
      for (const l of lines) {
        items.push({ orderId: id, productId: l.p.id, lineKey: l.p.id, name: l.p.name, priceCOP: l.p.price, unitCostCOP: l.p.cost, qty: l.qty, sentQty: l.qty, addedAt: opened });
      }

      const splitId = `${id}-split`;
      splits.push({ id: splitId, tenantId: def.tenantId, orderId: id, totalCOP: total, paidAt: closed });
      for (const l of lines) {
        splitItems.push({ splitId, productId: l.p.id, name: l.p.name, qty: l.qty, priceCOP: l.p.price, unitCostCOP: l.p.cost });
      }
      const method = weighted([{ m: 'cash', weight: 72 }, { m: 'qr', weight: 18 }, { m: 'card', weight: 10 }]).m;
      if (method === 'cash' && total > 30000 && chance(0.06)) {
        // Pago mixto: parte en efectivo, el resto por QR.
        const cashPart = roundTo(total * 0.5, 1000);
        contribs.push({ splitId, method: 'cash', amount: cashPart, cashReceived: cashPart, cashChange: 0 });
        contribs.push({ splitId, method: 'qr', amount: total - cashPart });
        if (d === 0) todaySales.push({ orderId: id, method: 'cash', amount: cashPart, at: closed }, { orderId: id, method: 'qr', amount: total - cashPart, at: closed });
      } else {
        const received = method === 'cash' ? Math.ceil(total / (total > 50000 ? 50000 : 10000)) * (total > 50000 ? 50000 : 10000) : null;
        contribs.push({
          splitId,
          method,
          amount: total,
          cardType: method === 'card' ? pick(['credit', 'debit']) : null,
          cashReceived: received,
          cashChange: received !== null ? received - total : null,
        });
        if (d === 0) todaySales.push({ orderId: id, method, amount: total, at: closed });
      }
    }
  }

  // Mesas ocupadas ahora mismo: lo que se ve al abrir el POS en el video.
  const LIVE: { code: string; status: string; mins: number; ticket: 'PENDING' | 'PREPARING' | 'READY' | 'SERVED' }[] = [
    { code: 'M-2', status: 'PREPARING', mins: 8, ticket: 'PENDING' },
    { code: 'M-5', status: 'PREPARING', mins: 18, ticket: 'PREPARING' },
    { code: 'T-01', status: 'ON_TABLE', mins: 35, ticket: 'SERVED' },
    { code: 'M-7', status: 'PAYMENT', mins: 55, ticket: 'SERVED' },
    { code: 'B-2', status: 'ON_TABLE', mins: 22, ticket: 'READY' },
  ];
  const tickets: Prisma.KitchenTicketCreateManyInput[] = [];
  const ticketItems: Prisma.KitchenTicketItemCreateManyInput[] = [];
  for (const live of LIVE) {
    const table = tables.find((x) => x.code === live.code)!;
    const id = `${def.tenantId}-ord-live-${live.code}`;
    const opened = minutesAgo(live.mins);
    const lines = buildOrderLines(Math.min(table.seats, int(2, 4)));
    orders.push({ id, ...t, tableId: table.id, terminalId: TERMINAL, waiterId: pick(waiters), status: 'OPEN', createdAt: opened });
    for (const l of lines) {
      items.push({ orderId: id, productId: l.p.id, lineKey: l.p.id, name: l.p.name, priceCOP: l.p.price, unitCostCOP: l.p.cost, qty: l.qty, sentQty: l.qty, addedAt: opened });
    }
    const ticketId = `${id}-ticket`;
    const sent = addMin(opened, 2);
    tickets.push({
      id: ticketId,
      tenantId: def.tenantId,
      orderId: id,
      status: live.ticket,
      priority: live.code === 'M-5' ? 'urgent' : 'normal',
      sentAt: sent,
      readyAt: ['READY', 'SERVED'].includes(live.ticket) ? addMin(sent, 15) : null,
      servedAt: live.ticket === 'SERVED' ? addMin(sent, 18) : null,
    });
    for (const l of lines) {
      ticketItems.push({ ticketId, productId: l.p.id, lineKey: l.p.id, name: l.p.name, qty: l.qty, notes: chance(0.2) ? pick(['Sin cebolla', 'Término medio', 'Salsas aparte']) : null });
    }
    await prisma.restaurantTable.update({ where: { id: table.id }, data: { status: live.status } });
  }

  await prisma.order.createMany({ data: orders });
  await prisma.orderItem.createMany({ data: items });
  await prisma.paymentSplit.createMany({ data: splits });
  await prisma.paymentContribution.createMany({ data: contribs });
  await prisma.paymentSplitItem.createMany({ data: splitItems });
  await prisma.kitchenTicket.createMany({ data: tickets });
  await prisma.kitchenTicketItem.createMany({ data: ticketItems });

  // Caja abierta hoy, con las ventas de hoy ya registradas.
  const opening = 150000;
  const session = await prisma.cashSession.create({
    data: { ...t, terminalId: TERMINAL, status: 'OPEN', openedAt: atCO(0, 11, 30), openedByUserId: ownerId, openingAmount: opening, openingNote: 'Base del día' },
  });
  await prisma.cashMovement.createMany({
    data: [
      { sessionId: session.id, type: 'OPENING', method: 'cash', amount: opening, createdByUserId: ownerId, createdAt: atCO(0, 11, 30) },
      ...todaySales.map((s) => ({ sessionId: session.id, type: 'SALE' as const, method: s.method, amount: s.amount, reference: s.orderId, createdByUserId: ownerId, createdAt: s.at })),
    ],
  });

  const nExp = await seedExpenses(def, [
    { category: 'RENT', concept: 'Arriendo local', amountCOP: 2200000, dayOfMonth: 1 },
    { category: 'UTILITIES', concept: 'Luz, agua y gas', amountCOP: 420000, dayOfMonth: 15, jitter: 0.1 },
    { category: 'PAYROLL', concept: 'Quincena meseros', amountCOP: 1950000, dayOfMonth: 15 },
    { category: 'PAYROLL', concept: 'Quincena meseros', amountCOP: 1950000, dayOfMonth: 30 },
    { category: 'INVENTORY_PURCHASE', concept: 'Mercado proveedor carnes y panes', amountCOP: 1100000, everyDays: 7, jitter: 0.2 },
    { category: 'KITCHEN', concept: 'Desechables y empaques', amountCOP: 120000, everyDays: 10, jitter: 0.25 },
    { category: 'PLATFORM', concept: 'Suscripción Lynko', amountCOP: 92000, dayOfMonth: 5 },
  ]);

  const closed = orders.filter((o) => o.status === 'CLOSED');
  console.log(`  ✓ ${products.length} productos · ${tables.length} mesas · ${closed.length} órdenes cerradas · ${LIVE.length} mesas activas · ${nExp} gastos`);
}

// ─── Barbería ────────────────────────────────────────────────────────────────

const BARBER_SERVICES: { name: string; category: string; price: number; dur: number; weight: number; desc: string }[] = [
  { name: 'Corte clásico', category: 'Cortes', price: 25000, dur: 30, weight: 10, desc: 'Tijera y máquina, lavado incluido.' },
  { name: 'Corte + barba', category: 'Cortes', price: 38000, dur: 45, weight: 8, desc: 'Corte completo con perfilado de barba.' },
  { name: 'Fade / degradado', category: 'Cortes', price: 30000, dur: 40, weight: 7, desc: 'Degradado a navaja con acabado.' },
  { name: 'Corte niño', category: 'Cortes', price: 18000, dur: 25, weight: 3, desc: 'Hasta 12 años.' },
  { name: 'Arreglo de barba', category: 'Barba', price: 15000, dur: 20, weight: 5, desc: 'Perfilado y toalla caliente.' },
  { name: 'Afeitado clásico', category: 'Barba', price: 28000, dur: 35, weight: 2, desc: 'Navaja, espuma y toalla caliente.' },
  { name: 'Cejas', category: 'Cuidado', price: 10000, dur: 15, weight: 3, desc: 'Perfilado con cuchilla.' },
  { name: 'Mascarilla facial', category: 'Cuidado', price: 22000, dur: 25, weight: 1, desc: 'Limpieza con mascarilla negra.' },
  { name: 'Tinte / color', category: 'Color', price: 60000, dur: 75, weight: 1, desc: 'Color completo o mechas.' },
];

async function seedBarber() {
  const def = DEMO.barber;
  console.log(`→ ${def.name}`);
  const { ownerId } = await seedBase(def);
  const t = { tenantId: def.tenantId, branchId: def.branchId };

  // Martes a sábado 9–19, domingo 10–15, lunes cerrado.
  const open = (start: string, end: string) => [{ start, end }];
  const businessHours = {
    monday: [],
    tuesday: open('09:00', '19:00'),
    wednesday: open('09:00', '19:00'),
    thursday: open('09:00', '19:00'),
    friday: open('09:00', '20:00'),
    saturday: open('08:00', '20:00'),
    sunday: open('10:00', '15:00'),
  };
  const HOURS_BY_DOW: ([number, number] | null)[] = [[10, 15], null, [9, 19], [9, 19], [9, 19], [9, 20], [8, 20]];

  await prisma.barberSettings.create({
    data: {
      ...t,
      phone: '3000000000',
      city: 'Bogotá',
      neighborhood: 'Barrio Demo',
      bookingSlug: 'barberia-demo-1',
      businessHours,
      shortName: 'Demo 1',
      tagline: 'Cortes clásicos y modernos',
      heroTitle: 'Barbería Demo 1',
      heroDescription: 'Reserva tu turno en línea en menos de un minuto.',
      description: 'Barbería de demostración de Lynko.',
      highlights: ['Reserva en línea', 'Toalla caliente', 'Sin filas'],
      themePrimaryColor: '#c2410c',
      themeAccentColor: '#facc15',
      themeInkColor: '#1c1917',
    },
  });

  const services: { id: string; price: number; cost: number; dur: number; weight: number; name: string }[] = [];
  for (const [i, s] of BARBER_SERVICES.entries()) {
    const id = `${def.tenantId}-svc-${i}`;
    const cost = roundTo(s.price * 0.18, 500);
    services.push({ id, price: s.price, cost, dur: s.dur, weight: s.weight, name: s.name });
    await prisma.barberService.create({
      data: { id, ...t, name: s.name, description: s.desc, category: s.category, durationMin: s.dur, priceCOP: s.price, costCOP: cost, sortOrder: i },
    });
  }

  const STAFF_COLORS = ['#f97316', '#3b82f6', '#22c55e'];
  const staff: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = `${def.tenantId}-staff-${i + 1}`;
    staff.push(id);
    await prisma.barberStaff.create({
      data: { id, ...t, name: `Barbero Demo ${i + 1}`, color: STAFF_COLORS[i], sortOrder: i, services: { create: services.map((s) => ({ serviceId: s.id })) } },
    });
  }

  // Clientes: unos pocos fijos que vuelven mucho, la mayoría ocasionales.
  const customers = Array.from({ length: 80 }, (_, i) => ({
    id: `${def.tenantId}-cli-${pad(i + 1)}`,
    name: `Cliente Demo ${pad(i + 1)}`,
    phone: `30000${pad(i + 1, 5)}`,
    weight: i < 15 ? 6 : i < 40 ? 2 : 1,
  }));
  await prisma.barberCustomer.createMany({
    data: customers.map((c) => ({ id: c.id, ...t, name: c.name, phone: c.phone, createdAt: atCO(DAYS + 2, 9) })),
  });

  const appts: Prisma.BarberAppointmentCreateManyInput[] = [];
  const events: Prisma.BarberAppointmentEventCreateManyInput[] = [];
  let seq = 0;

  // De DAYS días atrás hasta 7 días adelante. Negativo = futuro.
  for (let d = DAYS; d >= -7; d--) {
    const hours = HOURS_BY_DOW[weekdayCO(d)];
    if (!hours) continue;
    const fill = d > 0 ? 0.7 * trend(d) : d === 0 ? 0.75 : Math.max(0.15, 0.6 - 0.07 * -d);
    for (const staffId of staff) {
      let cursor = hours[0] * 60 + pick([0, 15, 30]);
      while (cursor < hours[1] * 60 - 20) {
        const svc = weighted(services);
        if (!chance(fill)) {
          cursor += 30;
          continue;
        }
        const start = atCO(d, 0, cursor);
        const end = addMin(start, svc.dur);
        cursor += svc.dur + pick([0, 0, 5, 10, 15]);
        if (cursor > hours[1] * 60) break;

        const past = end.getTime() < NOW.getTime();
        const id = `${def.tenantId}-appt-${pad(++seq, 5)}`;
        const customer = weighted(customers);
        const source = chance(0.35) ? 'public' : 'manual';
        let status: string;
        if (past) status = chance(0.05) ? 'CANCELLED' : 'COMPLETED';
        else status = source === 'public' && chance(0.3) ? 'PENDING' : chance(0.5) ? 'CONFIRMED' : 'SCHEDULED';
        const completed = status === 'COMPLETED';

        appts.push({
          id, ...t, customerId: customer.id, serviceId: svc.id, staffId,
          scheduledAt: start, scheduledEnd: end, status, source,
          servedAt: completed ? start : null,
          priceCOP: completed ? svc.price : null,
          costCOP: completed ? svc.cost : null,
          cancelReason: status === 'CANCELLED' ? 'El cliente reprogramó' : null,
          createdAt: addMin(start, -int(60, 4 * 24 * 60)),
        });
        if (completed) {
          events.push({ tenantId: def.tenantId, branchId: def.branchId, appointmentId: id, kind: 'COMPLETED', summary: `Servicio prestado · $${svc.price.toLocaleString('es-CO')}`, detail: { servedAt: start.toISOString(), priceCOP: svc.price, costCOP: svc.cost }, userId: ownerId, userName: def.ownerName, occurredAt: end });
        }
      }
    }
  }
  await prisma.barberAppointment.createMany({ data: appts });
  await prisma.barberAppointmentEvent.createMany({ data: events });

  // Contadores del cliente: los mismos que mantiene syncCustomerVisits.
  await prisma.$executeRaw`
    UPDATE barber_customers c SET
      "totalVisits" = s.n, "lastVisitAt" = s.last
    FROM (
      SELECT "customerId", count(*)::int n, max("servedAt") last
      FROM barber_appointments
      WHERE "tenantId" = ${def.tenantId} AND status = 'COMPLETED'
      GROUP BY "customerId"
    ) s
    WHERE c.id = s."customerId"`;

  const nExp = await seedExpenses(def, [
    { category: 'RENT', concept: 'Arriendo local', amountCOP: 1500000, dayOfMonth: 1 },
    { category: 'UTILITIES', concept: 'Luz, agua e internet', amountCOP: 260000, dayOfMonth: 12, jitter: 0.1 },
    { category: 'OPERATIONS', concept: 'Cuchillas, talco y toallas', amountCOP: 180000, everyDays: 14, jitter: 0.2 },
    { category: 'PLATFORM', concept: 'Suscripción Lynko', amountCOP: 92000, dayOfMonth: 5 },
  ]);

  const done = appts.filter((a) => a.status === 'COMPLETED').length;
  const upcoming = appts.filter((a) => ['SCHEDULED', 'CONFIRMED', 'PENDING'].includes(a.status as string)).length;
  console.log(`  ✓ ${services.length} servicios · ${staff.length} barberos · ${customers.length} clientes · ${done} atendidas · ${upcoming} por venir · ${nExp} gastos`);
}

// ─── Tienda (retail) ─────────────────────────────────────────────────────────

const COLORS = {
  negro: ['Negro', '#111111'],
  blanco: ['Blanco', '#f5f5f5'],
  azul: ['Azul', '#1d4ed8'],
  rosado: ['Rosado', '#f472b6'],
  verde: ['Verde', '#16a34a'],
  gris: ['Gris', '#6b7280'],
} as const;
type ColorKey = keyof typeof COLORS;

const RETAIL_CATALOG: { cat: string; emoji: string; items: { name: string; price: number; weight: number; colors?: ColorKey[]; stock?: number }[] }[] = [
  { cat: 'Fundas', emoji: '📱', items: [
    { name: 'Funda silicona iPhone 15', price: 35000, weight: 8, colors: ['negro', 'azul', 'rosado', 'verde'] },
    { name: 'Funda antichoque Galaxy A55', price: 32000, weight: 6, colors: ['negro', 'gris', 'azul'] },
    { name: 'Funda transparente MagSafe', price: 45000, weight: 4 },
    { name: 'Funda billetera cuero', price: 55000, weight: 2, colors: ['negro', 'gris'] },
  ] },
  { cat: 'Vidrios templados', emoji: '🛡️', items: [
    { name: 'Vidrio templado 9D', price: 15000, weight: 10 },
    { name: 'Vidrio antiespía', price: 28000, weight: 4 },
    { name: 'Protector de cámara', price: 18000, weight: 3, stock: 2 },
  ] },
  { cat: 'Cargadores', emoji: '🔌', items: [
    { name: 'Cargador carga rápida 20 W', price: 49000, weight: 6 },
    { name: 'Cargador 45 W USB-C', price: 79000, weight: 3 },
    { name: 'Power bank 10.000 mAh', price: 89000, weight: 3, colors: ['negro', 'blanco'] },
    { name: 'Cargador inalámbrico', price: 65000, weight: 2, stock: 1 },
  ] },
  { cat: 'Cables', emoji: '🔗', items: [
    { name: 'Cable USB-C a USB-C 1 m', price: 22000, weight: 6 },
    { name: 'Cable Lightning 1 m', price: 25000, weight: 5 },
    { name: 'Cable trenzado 2 m', price: 32000, weight: 2 },
  ] },
  { cat: 'Audio', emoji: '🎧', items: [
    { name: 'Audífonos inalámbricos TWS', price: 99000, weight: 5, colors: ['negro', 'blanco'] },
    { name: 'Audífonos de cable', price: 25000, weight: 3 },
    { name: 'Parlante bluetooth mini', price: 120000, weight: 2, colors: ['negro', 'azul', 'rosado'] },
  ] },
  { cat: 'Relojes', emoji: '⌚', items: [
    { name: 'Smartwatch deportivo', price: 159000, weight: 2, colors: ['negro', 'rosado', 'gris'] },
    { name: 'Correa de silicona', price: 30000, weight: 3, colors: ['negro', 'blanco', 'azul', 'verde'] },
  ] },
];

const PAY_LABEL: Record<string, string> = { CASH: 'Efectivo', TRANSFER: 'Transferencia', CARD: 'Tarjeta' };
const cop = (n: number) => `$${n.toLocaleString('es-CO')}`;

async function seedRetail() {
  const def = DEMO.retail;
  console.log(`→ ${def.name}`);
  const { ownerId } = await seedBase(def);
  const t = { tenantId: def.tenantId, branchId: def.branchId };

  // Mismo id que usan la migración y ensureDefaultLocation.
  const locationId = `loc_${def.tenantId}_${def.branchId}`;
  await prisma.retailStockLocation.create({ data: { id: locationId, ...t, name: 'Bodega principal', isDefault: true, sortOrder: 0 } });

  type Unit = { productId: string; variantId: string | null; label: string | null; key: string };
  type RP = { id: string; name: string; sku: string; price: number; cost: number; w6: number; weight: number; units: Unit[]; lowStock?: number };
  const products: RP[] = [];
  let skuSeq = 0;

  for (const [ci, c] of RETAIL_CATALOG.entries()) {
    const categoryId = `${def.tenantId}-cat-${ci}`;
    await prisma.retailCategory.create({ data: { id: categoryId, ...t, name: c.cat, emoji: c.emoji, sortOrder: ci } });

    for (const [pi, it] of c.items.entries()) {
      const id = `${def.tenantId}-prod-${ci}-${pi}`;
      const sku = `DEMO-${pad(++skuSeq, 4)}`;
      const cost = roundTo(it.price * between(0.42, 0.55), 500);
      const optionId = `${id}-opt-color`;
      const options = it.colors
        ? [{
            id: optionId, kind: 'color', label: 'Color', required: true,
            values: it.colors.map((k) => ({ id: `${id}-${k}`, label: COLORS[k][0], copy: null, hex: COLORS[k][1], imageUrls: [], isAvailable: true })),
          }]
        : null;

      await prisma.retailProduct.create({
        data: {
          id, ...t, categoryId, sku, name: it.name, brand: 'Genérico',
          costCOP: cost, avgCostCOP: cost, priceCOP: it.price,
          saleMarginPct: Math.round((1 - cost / it.price) * 1000) / 10,
          wholesalePrice6COP: roundTo(it.price * 0.85, 1000),
          wholesalePrice12COP: roundTo(it.price * 0.78, 1000),
          emoji: c.emoji, imageUrls: [], videoUrls: [], minStock: 3, sortOrder: pi,
          options: options ?? Prisma.DbNull,
          stockOptionId: it.colors ? optionId : null,
          stockOptionIds: it.colors ? [optionId] : [],
        },
      });

      const units: Unit[] = [];
      if (it.colors) {
        for (const k of it.colors) {
          const variantId = `${id}-var-${k}`;
          await prisma.retailProductVariant.create({
            data: { id: variantId, tenantId: def.tenantId, branchId: def.branchId, productId: id, optionValueId: `${id}-${k}`, optionValueIds: [`${id}-${k}`], combinationKey: `${id}-${k}`, label: COLORS[k][0], sku: `${sku}-${k.toUpperCase()}`, minStock: 1 },
          });
          units.push({ productId: id, variantId, label: COLORS[k][0], key: variantId });
        }
      } else {
        units.push({ productId: id, variantId: null, label: null, key: id });
      }
      products.push({ id, name: it.name, sku, price: it.price, cost, w6: roundTo(it.price * 0.85, 1000), weight: it.weight, units, lowStock: it.stock });
    }
  }

  const customers = Array.from({ length: 35 }, (_, i) => ({
    id: `${def.tenantId}-cli-${pad(i + 1)}`,
    name: `Cliente Demo ${pad(i + 1)}`,
    phone: `30100${pad(i + 1, 5)}`,
    weight: i < 8 ? 5 : 1,
  }));
  await prisma.retailCustomer.createMany({ data: customers.map((c) => ({ id: c.id, ...t, name: c.name, phone: c.phone, createdAt: atCO(DAYS + 2, 9) })) });

  // Ventas
  const RETAIL_DOW = [1.3, 0.7, 0.8, 0.9, 1.0, 1.3, 1.6];
  type Line = { p: RP; u: Unit; qty: number; unitPrice: number };
  const sales: Prisma.RetailSaleCreateManyInput[] = [];
  const saleItems: Prisma.RetailSaleItemCreateManyInput[] = [];
  const payments: Prisma.RetailSalePaymentCreateManyInput[] = [];
  const saleEvents: Prisma.RetailSaleEventCreateManyInput[] = [];
  const sold: { u: Unit; qty: number; at: Date; code: string; cost: number }[] = [];
  let seq = 0;
  const nowLocalHour = (NOW.getTime() - CO_OFFSET_MS) / 3_600_000 % 24;

  for (let d = DAYS; d >= 0; d--) {
    let count = Math.round(4 * RETAIL_DOW[weekdayCO(d)] * trend(d) * between(0.7, 1.3));
    let range: [number, number] = [9.5, 19.5];
    if (d === 0) {
      range = [9.5, Math.min(Math.max(nowLocalHour - 0.3, 9.6), 19.5)];
      count = nowLocalHour < 10 ? 0 : Math.max(2, Math.round(count * (range[1] - range[0]) / 10));
    }
    const times = Array.from({ length: count }, () => atCO(d, 0, Math.floor(between(range[0], range[1]) * 60))).sort((a, b) => a.getTime() - b.getTime());

    for (const soldAt of times) {
      const code = `RS-${pad(++seq, 6)}`;
      const id = `${def.tenantId}-sale-${pad(seq, 5)}`;
      const wholesale = chance(0.03);
      const lines: Line[] = [];
      const nLines = wholesale ? 1 : weighted([{ n: 1, weight: 6 }, { n: 2, weight: 3 }, { n: 3, weight: 1 }]).n;
      for (let i = 0; i < nLines; i++) {
        const p = weighted(products);
        if (lines.some((l) => l.p.id === p.id)) continue;
        lines.push({ p, u: pick(p.units), qty: wholesale ? 6 : chance(0.1) ? 2 : 1, unitPrice: wholesale ? p.w6 : p.price });
      }
      const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
      const discount = !wholesale && subtotal > 80000 && chance(0.15) ? roundTo(subtotal * 0.05, 1000) : 0;
      const shipping = chance(0.06) ? 12000 : 0;
      const total = subtotal - discount + shipping;
      const cost = lines.reduce((s, l) => s + l.p.cost * l.qty, 0);
      const method = weighted([{ m: 'CASH', weight: 45 }, { m: 'TRANSFER', weight: 38 }, { m: 'CARD', weight: 17 }]).m as 'CASH' | 'TRANSFER' | 'CARD';
      const customer = wholesale || chance(0.6) ? weighted(customers) : null;

      // Abonos: algunas ventas recientes quedan con saldo (para la bandeja de cobro).
      const status = customer && d <= 20 && chance(0.08) ? (chance(0.6) ? 'PARTIAL' : 'PENDING') : 'PAID';
      const paid = status === 'PAID' ? total : status === 'PARTIAL' ? roundTo(total * 0.5, 1000) : 0;
      const received = method === 'CASH' && paid > 0 ? Math.ceil(paid / 10000) * 10000 : null;

      sales.push({
        id, ...t, code, customerId: customer?.id ?? null, userId: ownerId,
        saleType: wholesale ? 'WHOLESALE' : 'RETAIL',
        paymentStatus: status, paidCOP: paid, paidAt: status === 'PAID' ? soldAt : null,
        deliveryStatus: 'DELIVERED', deliveredAt: soldAt,
        subtotalCOP: subtotal, discountCOP: discount, shippingCOP: shipping, totalCOP: total, costCOP: cost,
        paymentMethod: method, receivedCOP: received, changeCOP: received !== null ? received - paid : null,
        soldAt, createdAt: soldAt,
      });
      for (const l of lines) {
        saleItems.push({
          saleId: id, productId: l.p.id, variantId: l.u.variantId, name: l.p.name, variantLabel: l.u.label, sku: l.p.sku,
          quantity: l.qty, deliveredQty: l.qty, unitPriceCOP: l.unitPrice, unitCostCOP: l.p.cost, totalCOP: l.unitPrice * l.qty, locationId,
        });
        sold.push({ u: l.u, qty: l.qty, at: soldAt, code, cost: l.p.cost });
      }
      if (paid > 0) {
        payments.push({ tenantId: def.tenantId, branchId: def.branchId, saleId: id, amountCOP: paid, method, paidAt: soldAt, settledAt: soldAt, userId: ownerId, userName: def.ownerName, createdAt: soldAt });
      }
      saleEvents.push({
        tenantId: def.tenantId, branchId: def.branchId, saleId: id, kind: 'CREATED', userId: ownerId, userName: def.ownerName, occurredAt: soldAt,
        summary: status === 'PAID'
          ? `Venta registrada por ${cop(total)}, cobrada (${PAY_LABEL[method]})`
          : paid > 0
            ? `Venta registrada por ${cop(total)} · abonó ${cop(paid)} (${PAY_LABEL[method]}) · quedan ${cop(total - paid)}`
            : `Venta registrada por ${cop(total)}, sin cobrar`,
      });
    }
  }

  await prisma.retailSale.createMany({ data: sales });
  await prisma.retailSaleItem.createMany({ data: saleItems });
  await prisma.retailSalePayment.createMany({ data: payments });
  await prisma.retailSaleEvent.createMany({ data: saleEvents });

  // Inventario: se fija el saldo final y la carga inicial es saldo + vendido,
  // así el kardex cuadra fila por fila. Unos pocos quedan bajo el mínimo.
  const soldByUnit = new Map<string, number>();
  for (const s of sold) soldByUnit.set(s.u.key, (soldByUnit.get(s.u.key) ?? 0) + s.qty);

  const movements: Prisma.RetailStockMovementCreateManyInput[] = [];
  const balances: Prisma.RetailStockBalanceCreateManyInput[] = [];
  const stockAfter = new Map<string, number>();
  const finalByUnit = new Map<string, number>();

  for (const p of products) {
    for (const u of p.units) {
      const final = p.lowStock !== undefined ? p.lowStock : p.units.length > 1 ? int(2, 9) : int(6, 25);
      const initial = final + (soldByUnit.get(u.key) ?? 0);
      finalByUnit.set(u.key, final);
      stockAfter.set(u.key, initial);
      movements.push({ ...t, productId: u.productId, variantId: u.variantId, type: 'INITIAL', quantity: initial, stockAfter: initial, locationId, unitCostCOP: p.cost, reason: 'Carga inicial', userId: ownerId, createdAt: atCO(DAYS + 1, 9) });
      balances.push({ tenantId: def.tenantId, branchId: def.branchId, locationId, productId: u.productId, variantId: u.variantId, qty: final });
    }
  }
  for (const s of sold) {
    const after = stockAfter.get(s.u.key)! - s.qty;
    stockAfter.set(s.u.key, after);
    movements.push({ ...t, productId: s.u.productId, variantId: s.u.variantId, type: 'SALE', quantity: -s.qty, stockAfter: after, locationId, unitCostCOP: s.cost, reference: s.code, userId: ownerId, createdAt: s.at });
  }
  await prisma.retailStockMovement.createMany({ data: movements });
  await prisma.retailStockBalance.createMany({ data: balances });

  for (const p of products) {
    const stock = p.units.reduce((s, u) => s + finalByUnit.get(u.key)!, 0);
    await prisma.retailProduct.update({ where: { id: p.id }, data: { stock } });
    for (const u of p.units) {
      if (u.variantId) await prisma.retailProductVariant.update({ where: { id: u.variantId }, data: { stock: finalByUnit.get(u.key)! } });
    }
  }

  await prisma.$executeRaw`
    UPDATE retail_customers c SET
      "totalSpentCOP" = s.total, "salesCount" = s.n, "lastPurchaseAt" = s.last
    FROM (
      SELECT "customerId", sum("totalCOP")::int total, count(*)::int n, max("soldAt") last
      FROM retail_sales
      WHERE "tenantId" = ${def.tenantId} AND status = 'COMPLETED' AND "customerId" IS NOT NULL
      GROUP BY "customerId"
    ) s
    WHERE c.id = s."customerId"`;

  const nExp = await seedExpenses(def, [
    { category: 'RENT', concept: 'Arriendo local', amountCOP: 1300000, dayOfMonth: 1 },
    { category: 'UTILITIES', concept: 'Luz e internet', amountCOP: 210000, dayOfMonth: 12, jitter: 0.1 },
    { category: 'INVENTORY_PURCHASE', concept: 'Pedido a proveedor', amountCOP: 1800000, everyDays: 15, jitter: 0.25 },
    { category: 'OPERATIONS', concept: 'Publicidad en redes', amountCOP: 150000, everyDays: 14, jitter: 0.2 },
    { category: 'PLATFORM', concept: 'Suscripción Lynko', amountCOP: 135000, dayOfMonth: 5 },
  ]);

  const pending = sales.filter((s) => s.paymentStatus !== 'PAID').length;
  console.log(`  ✓ ${products.length} productos · ${customers.length} clientes · ${sales.length} ventas (${pending} con saldo) · ${nExp} gastos`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  assertLocalDatabase();
  console.log(`Sembrando demo en réplica local · ${DAYS} días de historia${CREATE_AUTH ? ' · creando usuarios en Supabase Auth' : ''}`);

  const run: Record<DemoKey, () => Promise<void>> = { restaurant: seedRestaurant, barber: seedBarber, retail: seedRetail };
  for (const key of Object.keys(run) as DemoKey[]) {
    if (ONLY && ONLY !== key) continue;
    rand = mulberry32(20261001 + key.length); // misma semilla por vertical, corra sola o con las demás
    await run[key]();
  }

  console.log('\nLogins (clave: la de --password):');
  for (const key of Object.keys(DEMO) as DemoKey[]) {
    if (ONLY && ONLY !== key) continue;
    console.log(`  ${DEMO[key].name.padEnd(20)} ${DEMO[key].ownerEmail}`);
  }
}

main()
  .catch((err) => {
    console.error(`✗ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
