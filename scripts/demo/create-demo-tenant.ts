import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Prisma, PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Núcleo reutilizable para crear una demo de un negocio nuevo en SOLO LOCAL.
 *
 *   createDemoTenant(prisma, { name: 'KallpaBox', preset: 'gimnasio' })
 *
 * Lo usa hoy el comando `npm run demo:new`. Más adelante lo puede llamar una
 * pantalla del superadmin o del landing sin reescribir nada: recibe datos y
 * devuelve datos, no imprime ni lee argv.
 *
 * Reglas:
 *  - Se niega a correr si DATABASE_URL no es localhost.
 *  - Idempotente por nombre: volver a correrlo borra y re-siembra esa demo.
 *  - El logo NO es parte de la creación: se sube después desde Ajustes.
 *  - Todo lo que es una persona se llama "… Demo N": que nadie lo confunda con
 *    un cliente real.
 */

export interface DemoOptions {
  /** Nombre del negocio, tal como se verá. */
  name: string;
  /** Nombre del archivo en scripts/demo/presets (sin .json). */
  preset: string;
  /** Correo del dueño. Por defecto demo.<slug>@uselynko.com */
  ownerEmail?: string;
  ownerName?: string;
  /** Crea (o actualiza la clave de) el usuario en Supabase Auth. */
  createAuth?: boolean;
  password?: string;
  /** Datos del negocio que se ven en la página pública. */
  address?: string;
  city?: string;
  neighborhood?: string;
  tagline?: string;
  /** Plan de la demo. Por defecto PREMIUM: nada aparece bloqueado. */
  plan?: 'BASIC' | 'PRO' | 'PREMIUM';
}

export interface DemoResult {
  tenantId: string;
  branchId: string;
  slug: string;
  ownerEmail: string;
  bookingPath: string;
  summary: string[];
}

// ─── Preset ──────────────────────────────────────────────────────────────────

interface Preset {
  id: string;
  vertical: string;
  bookingMode: 'fitness' | 'services' | 'resources';
  tagline: string;
  highlights: string[];
  theme: { primary: string; accent: string; ink: string };
  hours: Record<string, { start: string; end: string }[]>;
  staff: { name: string; color: string }[];
  classes: {
    name: string;
    description: string;
    durationMin: number;
    capacity: number;
    priceCOP: number;
    color: string;
    /** `weekday` puede ser una lista: se expande a un horario por día. */
    slots: { weekday: number | number[]; time: string; coach: number }[];
  }[];
  plans: {
    name: string;
    kind: 'PLAN' | 'PACKAGE';
    priceCOP: number;
    validityDays: number;
    description: string;
    sessionsPerMonth?: number;
    sessionsIncluded?: number;
  }[];
  customers: {
    plan: number | null;
    startedDaysAgo: number;
    paid: 'full' | 'partial' | 'none';
    attendance: number;
  }[];
}

function loadPreset(id: string): Preset {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Preset inválido: "${id}"`);
  let raw: string;
  try {
    raw = readFileSync(join(__dirname, 'presets', `${id}.json`), 'utf8');
  } catch {
    throw new Error(`No existe el preset "${id}" en scripts/demo/presets.`);
  }
  const preset = JSON.parse(raw) as Preset;
  for (const c of preset.classes) {
    c.slots = c.slots.flatMap((s) =>
      (Array.isArray(s.weekday) ? s.weekday : [s.weekday]).map((weekday) => ({ ...s, weekday })),
    );
  }
  return preset;
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function assertLocalDatabase() {
  const url = process.env.DATABASE_URL ?? '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* host vacío → falla abajo */
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(
      `DATABASE_URL apunta a "${host || '(vacío)'}". La demo solo corre contra la base local.`,
    );
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

// Aleatorio determinista: la misma demo se ve igual cada vez que se reinicia.
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

// Hora Colombia (UTC-5, sin horario de verano).
const CO_OFFSET_MS = 5 * 60 * 60_000;
const DAY_MS = 86_400_000;

function todayCO(now: Date): Date {
  const local = new Date(now.getTime() - CO_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

/** Instante para el día `offset` (negativo = pasado) a la hora local "HH:mm". */
function atCO(today: Date, offset: number, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(today.getTime() + offset * DAY_MS + (h * 60 + m) * 60_000 + CO_OFFSET_MS);
}

const dayOnly = (today: Date, offset: number) => new Date(today.getTime() + offset * DAY_MS);

// ─── Supabase Auth ───────────────────────────────────────────────────────────

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

async function resolveOwnerAuthId(
  opts: { email: string; tenantId: string; roleId: string; createAuth?: boolean; password?: string },
): Promise<string> {
  const appMetadata = { tenantId: opts.tenantId, roleId: opts.roleId };
  const existing = await findAuthUserId(opts.email);

  if (!opts.createAuth) {
    if (!existing) {
      throw new Error(
        `${opts.email} no existe en Supabase Auth. Corre con --create-auth --password <clave>.`,
      );
    }
    return existing;
  }
  if (!opts.password) throw new Error('--create-auth necesita --password <clave>.');

  if (existing) {
    const { error } = await auth().auth.admin.updateUserById(existing, {
      password: opts.password,
      app_metadata: appMetadata,
    });
    if (error) throw new Error(`Supabase updateUser ${opts.email}: ${error.message}`);
    return existing;
  }
  const { data, error } = await auth().auth.admin.createUser({
    email: opts.email,
    password: opts.password,
    email_confirm: true,
    app_metadata: appMetadata,
  });
  if (error || !data.user) throw new Error(`Supabase createUser ${opts.email}: ${error?.message}`);
  return data.user.id;
}

// ─── Borrado ─────────────────────────────────────────────────────────────────

/** Borra todo lo del tenant recorriendo cada tabla con "tenantId" hasta vaciarlas. */
async function wipeTenant(prisma: PrismaClient, tenantId: string) {
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenantId'`;

  for (let pass = 0; pass < 10; pass++) {
    let blocked = 0;
    for (const { table_name } of tables) {
      try {
        await prisma.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "tenantId" = $1`, tenantId);
      } catch {
        blocked++;
      }
    }
    if (blocked === 0) break;
    if (pass === 9) throw new Error(`No se pudo limpiar ${tenantId}: quedan referencias cruzadas.`);
  }
  await prisma.$executeRawUnsafe(`DELETE FROM "tenants" WHERE "id" = $1`, tenantId);
}

// ─── Creación ────────────────────────────────────────────────────────────────

export async function createDemoTenant(prisma: PrismaClient, opts: DemoOptions): Promise<DemoResult> {
  assertLocalDatabase();

  const name = opts.name.trim();
  if (name.length < 2) throw new Error('El nombre del negocio es muy corto.');
  const slug = slugify(name);
  if (!slug) throw new Error('El nombre no tiene letras ni números válidos.');

  const preset = loadPreset(opts.preset);
  const plan = opts.plan ?? 'PREMIUM';
  const tenantId = `tenant-demo-${slug}`;
  const branchId = `branch-demo-${slug}`;
  const ownerEmail = (opts.ownerEmail ?? `demo.${slug}@uselynko.com`).toLowerCase();
  const ownerName = opts.ownerName ?? `Dueño Demo ${name}`;
  const t = { tenantId, branchId };

  const now = new Date();
  const today = todayCO(now);
  const rand = mulberry32(slug.split('').reduce((s, c) => s + c.charCodeAt(0), 7));

  // El slug de reserva es único en toda la base: si lo usa otro tenant, falla claro.
  const clash = await prisma.barberSettings.findUnique({ where: { bookingSlug: slug } });
  if (clash && clash.tenantId !== tenantId) {
    throw new Error(`El enlace de reservas "${slug}" ya lo usa otro negocio. Usa otro nombre.`);
  }

  // Roles y permisos: copia de un negocio real de la misma vertical (solo códigos).
  const refTenant = await prisma.tenant.findFirst({
    where: {
      verticalId: preset.vertical,
      id: { not: tenantId },
      NOT: { id: { startsWith: 'tenant-demo-' } },
      roles: { some: { code: 'OWNER' } },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!refTenant) {
    throw new Error(`No hay un negocio de referencia (${preset.vertical}) en la base local para copiar roles.`);
  }

  await wipeTenant(prisma, tenantId);

  // ─ Tenant + sede + suscripción
  const periodEnd = dayOnly(today, 30);
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name,
      plan,
      verticalId: preset.vertical,
      status: 'ACTIVE',
      branches: {
        create: {
          id: branchId,
          name: 'Sede Principal',
          address: opts.address ?? 'Calle Demo # 1-23',
          phone: '3000000000',
        },
      },
      subscription: {
        create: {
          plan,
          status: 'ACTIVE',
          billingCycle: 'monthly',
          currentPeriodStart: today,
          currentPeriodEnd: periodEnd,
          nextPaymentDueAt: periodEnd,
          provider: 'manual',
        },
      },
    },
  });

  // ─ Roles
  const refRoles = await prisma.role.findMany({
    where: { tenantId: refTenant.id },
    include: { rolePermissions: { select: { permissionId: true } } },
  });
  const roleIds: Record<string, string> = {};
  for (const r of refRoles) {
    const id = `${tenantId}-role-${r.code.toLowerCase()}`;
    roleIds[r.code] = id;
    await prisma.role.create({
      data: {
        id,
        tenantId,
        code: r.code,
        name: r.name,
        isSystem: r.isSystem,
        rolePermissions: { create: r.rolePermissions.map((p) => ({ permissionId: p.permissionId })) },
      },
    });
  }

  // ─ Dueño
  const ownerId = await resolveOwnerAuthId({
    email: ownerEmail,
    tenantId,
    roleId: roleIds.OWNER,
    createAuth: opts.createAuth,
    password: opts.password,
  });
  await prisma.user.deleteMany({ where: { email: ownerEmail, NOT: { tenantId } } });
  await prisma.user.create({
    data: {
      id: ownerId,
      tenantId,
      email: ownerEmail,
      name: ownerName,
      roleId: roleIds.OWNER,
      passwordSetAt: now,
      userBranches: { create: { branchId } },
    },
  });

  // ─ Ajustes del negocio y página pública (sin logo: se sube después)
  await prisma.barberSettings.create({
    data: {
      ...t,
      phone: '3000000000',
      city: opts.city ?? 'Bogotá',
      neighborhood: opts.neighborhood ?? null,
      bookingSlug: slug,
      bookingMode: preset.bookingMode,
      businessHours: preset.hours,
      shortName: name,
      tagline: opts.tagline ?? preset.tagline,
      heroTitle: name,
      heroDescription: 'Reserva tu clase en línea en menos de un minuto.',
      description: `${name}: cuenta de demostración de Lynko.`,
      highlights: preset.highlights,
      themePrimaryColor: preset.theme.primary,
      themeAccentColor: preset.theme.accent,
      themeInkColor: preset.theme.ink,
      themeLogoMode: 'initials',
    },
  });

  // ─ Entrenadores
  const staffIds: string[] = [];
  for (const [i, s] of preset.staff.entries()) {
    const id = `${tenantId}-staff-${i + 1}`;
    staffIds.push(id);
    await prisma.barberStaff.create({ data: { id, ...t, name: s.name, color: s.color, sortOrder: i } });
  }

  // ─ Clases (servicios CLASS) y su horario semanal
  const classes: { id: string; def: Preset['classes'][number]; scheduleIds: string[] }[] = [];
  let order = 0;
  for (const [i, c] of preset.classes.entries()) {
    const id = `${tenantId}-class-${i + 1}`;
    await prisma.barberService.create({
      data: {
        id, ...t,
        name: c.name, description: c.description, kind: 'CLASS',
        durationMin: c.durationMin, priceCOP: c.priceCOP, capacity: c.capacity,
        color: c.color, category: 'Clases', sortOrder: order++,
        staffServices: undefined,
      } as Prisma.BarberServiceUncheckedCreateInput,
    });
    await prisma.barberStaffService.createMany({
      data: staffIds.map((staffId) => ({ staffId, serviceId: id })),
    });
    const scheduleIds: string[] = [];
    for (const [j, s] of c.slots.entries()) {
      const sid = `${tenantId}-sch-${i + 1}-${j + 1}`;
      scheduleIds.push(sid);
      await prisma.barberClassSchedule.create({
        data: {
          id: sid, ...t, serviceId: id, staffId: staffIds[s.coach] ?? null,
          weekday: s.weekday as number, startTime: s.time, durationMin: c.durationMin,
          capacity: c.capacity, activeFrom: dayOnly(today, -60),
        },
      });
    }
    classes.push({ id, def: c, scheduleIds });
  }

  // ─ Planes y paquetes
  const planIds: string[] = [];
  for (const [i, p] of preset.plans.entries()) {
    const id = `${tenantId}-plan-${i + 1}`;
    planIds.push(id);
    await prisma.barberService.create({
      data: {
        id, ...t,
        name: p.name, description: p.description, kind: p.kind,
        durationMin: 60, priceCOP: p.priceCOP, validityDays: p.validityDays,
        sessionsPerMonth: p.sessionsPerMonth ?? null, sessionsIncluded: p.sessionsIncluded ?? null,
        category: 'Planes', sortOrder: order++,
      },
    });
  }

  // ─ Clientes
  const customers = preset.customers.map((c, i) => ({
    id: `${tenantId}-cli-${pad(i + 1)}`,
    name: `Cliente Demo ${pad(i + 1)}`,
    phone: `3009${pad(i + 1, 6)}`,
    def: c,
  }));
  await prisma.barberCustomer.createMany({
    data: customers.map((c) => ({ id: c.id, ...t, name: c.name, phone: c.phone })),
  });

  // ─ Cobros de plan + pagos
  const chargeByCustomer = new Map<string, string>();
  const METHODS = ['CASH', 'NEQUI', 'TRANSFER', 'DAVIPLATA'];
  for (const [i, c] of customers.entries()) {
    if (c.def.plan === null) continue;
    const p = preset.plans[c.def.plan];
    const planId = planIds[c.def.plan];
    const startsOn = dayOnly(today, -c.def.startedDaysAgo);
    const endsOn = dayOnly(today, -c.def.startedDaysAgo + p.validityDays - 1);
    const chargeId = `${tenantId}-chg-${pad(i + 1)}`;
    const partial = c.def.paid === 'partial';
    await prisma.barberCharge.create({
      data: {
        id: chargeId, ...t, customerId: c.id, serviceId: planId,
        concept: p.name, totalCOP: p.priceCOP,
        chargedAt: atCO(today, -c.def.startedDaysAgo, '09:00'),
        startsOn, endsOn,
        dueOn: partial ? dayOnly(today, 3) : null,
        sessionsTotal: p.sessionsIncluded ?? null,
        sessionsPerMonth: p.sessionsPerMonth ?? null,
        userId: ownerId, userName: ownerName,
      },
    });
    chargeByCustomer.set(c.id, chargeId);
    if (c.def.paid !== 'none') {
      await prisma.barberPayment.create({
        data: {
          ...t, chargeId,
          amountCOP: partial ? Math.round(p.priceCOP / 2 / 1000) * 1000 : p.priceCOP,
          method: METHODS[i % METHODS.length],
          paidAt: atCO(today, -c.def.startedDaysAgo, '09:05'),
          userId: ownerId, userName: ownerName,
        },
      });
    }
  }

  // ─ Sesiones de clase: 7 días atrás hasta 14 adelante, con asistentes
  let sessionCount = 0;
  let attendeeCount = 0;
  for (const cls of classes) {
    for (const [j, slot] of cls.def.slots.entries()) {
      const scheduleId = cls.scheduleIds[j];
      for (let d = -7; d <= 14; d++) {
        if (dayOnly(today, d).getUTCDay() !== (slot.weekday as number)) continue;
        const startsAt = atCO(today, d, slot.time);
        const endsAt = new Date(startsAt.getTime() + cls.def.durationMin * 60_000);
        const sessionId = `${tenantId}-ses-${sessionCount + 1}`;
        await prisma.barberClassSession.create({
          data: {
            id: sessionId, ...t, scheduleId, serviceId: cls.id,
            staffId: staffIds[slot.coach] ?? null,
            startsAt, endsAt, capacity: cls.def.capacity,
          },
        });
        sessionCount++;

        const past = endsAt.getTime() < now.getTime();
        const rows: Prisma.BarberAppointmentCreateManyInput[] = [];
        for (const c of customers) {
          // Solo quien ya había empezado su plan ese día puede estar anotado.
          const started = -c.def.startedDaysAgo <= d;
          if (!started && c.def.plan !== null) continue;
          if (rand() > c.def.attendance * (past ? 0.55 : 0.4)) continue;
          if (rows.length >= cls.def.capacity) break;
          const chargeId = chargeByCustomer.get(c.id) ?? null;
          rows.push({
            ...t,
            customerId: c.id, serviceId: cls.id, staffId: staffIds[slot.coach] ?? null,
            scheduledAt: startsAt, scheduledEnd: endsAt, classSessionId: sessionId,
            coveredByChargeId: chargeId,
            status: past ? (rand() < 0.1 ? 'NO_SHOW' : 'COMPLETED') : 'CONFIRMED',
            servedAt: past ? startsAt : null,
            priceCOP: past ? (chargeId ? 0 : cls.def.priceCOP) : null,
            costCOP: past ? 0 : null,
            source: rand() < 0.4 ? 'public' : 'manual',
          });
        }
        if (rows.length) {
          await prisma.barberAppointment.createMany({ data: rows });
          attendeeCount += rows.length;
        }
      }
    }
  }

  // Contadores del cliente, los mismos que mantiene syncCustomerVisits.
  await prisma.$executeRaw`
    UPDATE barber_customers c SET "totalVisits" = s.n, "lastVisitAt" = s.last
    FROM (
      SELECT "customerId", count(*)::int n, max("servedAt") last
      FROM barber_appointments
      WHERE "tenantId" = ${tenantId} AND status = 'COMPLETED'
      GROUP BY "customerId"
    ) s
    WHERE c.id = s."customerId"`;

  return {
    tenantId,
    branchId,
    slug,
    ownerEmail,
    bookingPath: `/barber/book/${slug}`,
    summary: [
      `${classes.length} clases con ${classes.reduce((n, c) => n + c.scheduleIds.length, 0)} horarios semanales`,
      `${preset.plans.length} planes/paquetes · ${customers.length} clientes (uno con saldo, planes por vencer)`,
      `${sessionCount} sesiones (7 días atrás a 14 adelante) · ${attendeeCount} asistencias`,
    ],
  };
}
