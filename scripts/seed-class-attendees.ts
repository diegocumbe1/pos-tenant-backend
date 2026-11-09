import { config } from 'dotenv';
import { TenantContext } from '../src/auth/types/tenant-context.interface';
import { BarberAppointmentsService } from '../src/barber/modules/appointments/barber-appointments.service';
import { BarberChargesService } from '../src/barber/modules/charges/barber-charges.service';
import { BarberClassesService } from '../src/barber/modules/classes/barber-classes.service';
import { BarberTenantHelper } from '../src/barber/shared/barber-tenant.helper';
import { addCalendarDaysCO, calendarDayCO } from '../src/common/date.util';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Llena las clases del gimnasio con 4 o 5 personas, para tener datos de prueba
 * en Clases (por defecto In Move, semana actual y la siguiente).
 *
 * Usa clientes que ya existen y pasa por BarberClassesService: cupos, cobertura
 * del plan y visitas quedan igual que si se registraran desde la pantalla.
 *
 * - Cada horario queda con 2 inscritos fijos, los mismos toda la semana.
 * - El resto de cada clase son reservas puntuales, hasta llegar a 4 o 5.
 * - En las clases que ya pasaron, esas reservas quedan con asistencia marcada.
 * - Nunca saca a nadie ni pasa del cupo, y correrlo otra vez no duplica.
 *
 * SOLO LOCAL: lee `.env.local` (`.env` es producción) y se niega a correr si la
 * base no está en localhost. Sin `--commit` solo muestra lo que haría.
 *
 *   npx ts-node scripts/seed-class-attendees.ts
 *   npx ts-node scripts/seed-class-attendees.ts --commit
 *   npx ts-node scripts/seed-class-attendees.ts --email=otro@correo.com --weeks=4 --commit
 */

config({ path: '.env.local', override: true });

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const EMAIL = arg('email') ?? 'in-move@yopmail.com';
const WEEKS = Number(arg('weeks') ?? 2);
const COMMIT = process.argv.includes('--commit');
const FIXED_PER_GROUP = 2;

function assertLocalDatabase() {
  let host = '';
  try {
    host = new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    /* host vacío → falla abajo */
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(
      `DATABASE_URL apunta a "${host || '(vacío)'}". Este script solo corre contra la base local.`,
    );
  }
}

/** Lunes de la semana de esa fecha calendario. */
function mondayOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return addCalendarDaysCO(day, -((weekday + 6) % 7));
}

/** Número estable para un texto: la misma clase da siempre el mismo reparto. */
function hashOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

async function main() {
  assertLocalDatabase();
  if (!Number.isInteger(WEEKS) || WEEKS < 1 || WEEKS > 8) {
    throw new Error('--weeks debe ser un entero entre 1 y 8');
  }

  const prisma = new PrismaService();
  const helper = new BarberTenantHelper(prisma);
  const classes = new BarberClassesService(
    prisma,
    helper,
    new BarberAppointmentsService(prisma, helper),
    new BarberChargesService(prisma, helper),
  );

  try {
    const owner = await prisma.user.findUnique({
      where: { email: EMAIL },
      select: {
        id: true,
        tenantId: true,
        userBranches: { select: { branchId: true } },
      },
    });
    const branchId = owner?.userBranches[0]?.branchId;
    if (!owner?.tenantId || !branchId) {
      throw new Error(`No hay un negocio con sede para ${EMAIL}`);
    }
    const ctx = {
      userId: owner.id,
      email: EMAIL,
      name: 'Datos de prueba',
      tenantId: owner.tenantId,
      branchId,
    } as TenantContext;

    const customers = await prisma.barberCustomer.findMany({
      where: { tenantId: ctx.tenantId, branchId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    if (customers.length < 5) {
      throw new Error(
        `La sede solo tiene ${customers.length} clientes activos; hacen falta al menos 5.`,
      );
    }

    const from = mondayOf(calendarDayCO(new Date()));
    const to = addCalendarDaysCO(from, WEEKS * 7 - 1);
    console.log(`\n→ Base: local · Negocio: ${EMAIL} · ${from} a ${to}`);
    console.log(COMMIT ? '→ Modo: ESCRIBE\n' : '→ Modo: simulación (sin --commit)\n');

    // 1) Inscritos fijos: los mismos en todos los días de cada grupo.
    const schedules = (await classes.listSchedules(ctx)).filter(
      (s) => s.status === 'ACTIVE',
    );
    const groups = new Map<string, typeof schedules>();
    for (const schedule of schedules) {
      const key = `${schedule.serviceId}|${schedule.startTime}|${schedule.staffId}`;
      groups.set(key, [...(groups.get(key) ?? []), schedule]);
    }

    // La clase más llena de cada horario dice cuántos fijos más le caben.
    const fullest = new Map<string, number>();
    for (const s of await classes.listSessions(ctx, from, to)) {
      if (!s.scheduleId) continue;
      const taken = s.bookedCount + s.expectedCount;
      fullest.set(s.scheduleId, Math.max(fullest.get(s.scheduleId) ?? 0, taken));
    }

    const plannedFixed = new Map<string, string[]>();
    let fixedAdded = 0;
    for (const [key, group] of groups) {
      const offset = hashOf(key) % customers.length;
      const regulars = Array.from(
        { length: FIXED_PER_GROUP },
        (_, i) => customers[(offset + i) % customers.length],
      );
      for (const schedule of group) {
        const current = schedule.enrollments.map((e) => e.customerId);
        const room = schedule.capacity - (fullest.get(schedule.id) ?? 0);
        const missing = Math.max(
          0,
          Math.min(FIXED_PER_GROUP - current.length, room),
        );
        const toAdd = regulars
          .filter((c) => !current.includes(c.id))
          .slice(0, missing);
        plannedFixed.set(schedule.id, toAdd.map((c) => c.id));
        for (const customer of toAdd) {
          fixedAdded++;
          if (COMMIT) {
            await classes.enroll(ctx, schedule.id, {
              customerId: customer.id,
              activeFrom: from,
            });
          }
        }
      }
    }

    // 2) Reservas puntuales hasta llegar a 4 o 5 en cada clase.
    const now = Date.now();
    const sessions = (await classes.listSessions(ctx, from, to)).filter(
      (s) => s.status === 'SCHEDULED',
    );
    let bookingsAdded = 0;
    let classesTouched = 0;
    for (const session of sessions) {
      const ref = session.sessionId
        ? { sessionId: session.sessionId }
        : { scheduleId: session.scheduleId!, startsAt: session.startsAt };
      const roster = await classes.roster(ctx, ref);
      const inClass = new Set([
        ...roster.attendees.map((a) => a.customerId),
        ...roster.expected.map((e) => e.customerId),
        ...(session.scheduleId ? (plannedFixed.get(session.scheduleId) ?? []) : []),
      ]);

      // `session.key` cambia cuando la clase se guarda: no sirve para repartir.
      const seed = hashOf(`${session.scheduleId ?? session.key}|${session.startsAt}`);
      const target = Math.min(session.capacity, seed % 2 === 0 ? 4 : 5);
      const attended = new Date(session.startsAt).getTime() < now;
      let added = 0;
      for (let i = 0; i < customers.length && inClass.size < target; i++) {
        const customer = customers[(seed + i) % customers.length];
        if (inClass.has(customer.id)) continue;
        inClass.add(customer.id);
        added++;
        if (COMMIT) {
          await classes.addAttendee(ctx, {
            ...ref,
            customerId: customer.id,
            attended,
          });
        }
      }
      bookingsAdded += added;
      if (added > 0) classesTouched++;
      console.log(
        `  ${session.startsAt.slice(0, 16)}Z  ${session.serviceName.padEnd(24)} ` +
          `+${added} → ${inClass.size}/${session.capacity}`,
      );
    }

    console.log(`\nInscripciones fijas nuevas: ${fixedAdded}`);
    console.log(
      `Reservas puntuales nuevas: ${bookingsAdded} en ${classesTouched} de ${sessions.length} clases`,
    );
    if (!COMMIT) console.log('\nNo se escribió nada. Revisa y corre con --commit.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
