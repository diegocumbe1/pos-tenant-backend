import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Carga el histórico de clientas de una barbería desde un CSV.
 *
 * EL PROBLEMA QUE RESUELVE. Sin esto, meter un histórico son tres llamadas HTTP
 * por procedimiento: crear la clienta, crear la cita con fecha vieja y un PATCH
 * para completarla. Con 80 clientas de dos procedimientos son 480 llamadas a
 * mano, y las horas de acompañamiento prometidas se vuelven dos días.
 *
 * SIEMPRE SE CORRE PRIMERO EN SIMULACIÓN. Cargar la base de un cliente a ciegas
 * y descubrir el error después es peor que no cargarla: sin `--commit` esto
 * valida todo, imprime el reporte y no escribe nada.
 *
 *   Formato del CSV (con encabezado, separador `,` o `;`):
 *     nombre,telefono,servicio,fecha,precio,nota
 *     María Pérez,3001234567,Microblading,2025-03-14,300000,vino por Instagram
 *
 *   Uso:
 *     npx tsx scripts/import-barber-history.ts \
 *       --file=./malexca.csv \
 *       --tenant=tenant-e2593413 \
 *       --branch=branch-16e81337
 *     …y cuando el reporte se vea bien, otra vez con --commit
 */

const prisma = new PrismaClient();

// ─── Argumentos ──────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const FILE = arg('file');
const TENANT_ID = arg('tenant');
const BRANCH_ID = arg('branch');
const COMMIT = process.argv.includes('--commit');

if (!FILE || !TENANT_ID || !BRANCH_ID) {
  console.error(
    'Faltan argumentos: --file=<csv> --tenant=<tenantId> --branch=<branchId> [--commit]',
  );
  process.exit(1);
}

// ─── Parseo del CSV ──────────────────────────────────────────────────────────

/**
 * Normaliza para comparar nombres de servicio: sin tildes, sin mayúsculas, sin
 * espacios de más. "Micropigmentación" y "micropigmentacion" son el mismo
 * servicio, y quien digita el CSV no tiene por qué saberlo.
 */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // marcas de acento, ya separadas por NFD
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Deja solo dígitos: los teléfonos vienen como "300 123 4567" o "+57 300…". */
function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  // Un móvil colombiano son 10 dígitos; si viene con el 57 al frente, sobra.
  return digits.length === 12 && digits.startsWith('57')
    ? digits.slice(2)
    : digits;
}

/** Parsea una línea respetando comillas dobles, que es donde van las comas. */
function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      // Dos comillas seguidas dentro de un campo entrecomillado son una comilla.
      if (quoted && line[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === sep && !quoted) {
      out.push(field.trim());
      field = '';
    } else {
      field += char;
    }
  }
  out.push(field.trim());
  return out;
}

interface CsvRow {
  line: number;
  nombre: string;
  telefono: string;
  servicio: string;
  fecha: string;
  precio: string;
  nota: string;
}

function parseCsv(text: string): CsvRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  // El separador se detecta del encabezado: Excel en español exporta con `;`.
  const sep = (lines[0].match(/;/g)?.length ?? 0) > 0 ? ';' : ',';
  const header = splitLine(lines[0], sep).map(normalize);

  const idx = (...names: string[]) => {
    for (const n of names) {
      const at = header.indexOf(n);
      if (at !== -1) return at;
    }
    return -1;
  };
  const cols = {
    nombre: idx('nombre', 'cliente', 'name'),
    telefono: idx('telefono', 'celular', 'phone'),
    servicio: idx('servicio', 'procedimiento', 'service'),
    fecha: idx('fecha', 'date'),
    precio: idx('precio', 'valor', 'price'),
    nota: idx('nota', 'notas', 'observacion', 'note'),
  };

  const missing = (['nombre', 'telefono', 'servicio', 'fecha'] as const).filter(
    (k) => cols[k] === -1,
  );
  if (missing.length > 0) {
    throw new Error(
      `Al CSV le faltan columnas obligatorias: ${missing.join(', ')}. ` +
        `Encabezado leído: ${header.join(' | ')}`,
    );
  }

  return lines.slice(1).map((line, i) => {
    const parts = splitLine(line, sep);
    const at = (n: number) => (n === -1 ? '' : (parts[n] ?? ''));
    return {
      line: i + 2, // +2: la 1 es el encabezado y los humanos cuentan desde 1
      nombre: at(cols.nombre),
      telefono: at(cols.telefono),
      servicio: at(cols.servicio),
      fecha: at(cols.fecha),
      precio: at(cols.precio),
      nota: at(cols.nota),
    };
  });
}

/**
 * Acepta 'YYYY-MM-DD' y 'DD/MM/YYYY', que es como lo escribe todo el mundo acá.
 * Se ancla a mediodía en hora Colombia: así el día es el que se quiso, sin que
 * un corrimiento de zona lo pase al anterior.
 */
function parseDate(value: string): Date | null {
  const raw = value.trim();
  let iso: string | null = null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    iso = raw;
  } else {
    const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (dmy) {
      iso = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    }
  }
  if (!iso) return null;

  const date = new Date(`${iso}T12:00:00.000-05:00`);
  if (Number.isNaN(date.getTime())) return null;
  // Un procedimiento no se puede haber prestado en el futuro.
  if (date.getTime() > Date.now()) return null;
  return date;
}

function parsePrice(value: string): number | null {
  const digits = value.replace(/[^\d]/g, '');
  if (!digits) return null;
  return Number(digits);
}

// ─── Carga ───────────────────────────────────────────────────────────────────

interface Skipped {
  line: number;
  why: string;
}

async function main() {
  const rows = parseCsv(readFileSync(FILE!, 'utf8'));
  if (rows.length === 0) {
    console.error('El CSV no tiene filas de datos.');
    process.exit(1);
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: TENANT_ID },
    select: { name: true, vertical: { select: { code: true } } },
  });
  if (!tenant) throw new Error(`No existe el tenant ${TENANT_ID}`);
  if (tenant.vertical?.code !== 'barber') {
    throw new Error(`${tenant.name} no es un tenant de barbería`);
  }

  const services = await prisma.barberService.findMany({
    where: { tenantId: TENANT_ID, branchId: BRANCH_ID },
    select: {
      id: true,
      name: true,
      priceCOP: true,
      costCOP: true,
      durationMin: true,
    },
  });
  const byName = new Map(services.map((s) => [normalize(s.name), s]));

  const staff = await prisma.barberStaff.findFirst({
    where: { tenantId: TENANT_ID, branchId: BRANCH_ID, isActive: true },
    select: { id: true, name: true },
  });

  console.log(`\n▸ ${tenant.name}`);
  console.log(`  Archivo:    ${FILE}`);
  console.log(`  Filas:      ${rows.length}`);
  console.log(`  Servicios:  ${services.length} en el catálogo`);
  console.log(
    `  Modo:       ${COMMIT ? '⚠️  ESCRITURA REAL' : 'simulación (sin --commit no escribe nada)'}\n`,
  );

  // ─── Validación completa antes de escribir una sola fila ───────────────────
  const skipped: Skipped[] = [];
  const valid: {
    row: CsvRow;
    phone: string;
    service: (typeof services)[number];
    servedAt: Date;
    priceCOP: number;
  }[] = [];

  for (const row of rows) {
    const phone = normalizePhone(row.telefono);
    if (!row.nombre) {
      skipped.push({ line: row.line, why: 'sin nombre' });
      continue;
    }
    if (phone.length < 7) {
      skipped.push({
        line: row.line,
        why: `teléfono inválido: "${row.telefono}"`,
      });
      continue;
    }
    const service = byName.get(normalize(row.servicio));
    if (!service) {
      // No se inventa un servicio nuevo: se reporta y sigue. Crear servicios
      // desde un CSV llena el catálogo de duplicados con errores de digitación.
      skipped.push({
        line: row.line,
        why: `servicio no existe: "${row.servicio}"`,
      });
      continue;
    }
    const servedAt = parseDate(row.fecha);
    if (!servedAt) {
      skipped.push({
        line: row.line,
        why: `fecha inválida o futura: "${row.fecha}"`,
      });
      continue;
    }
    // El precio entra COMO VIENE EN EL ARCHIVO. Si en 2025 cobraban 250.000 por
    // el microblading, eso es lo que tiene que quedar congelado — no el precio
    // de hoy, que reescribiría el histórico con plata que nunca se cobró.
    const priceCOP = parsePrice(row.precio) ?? service.priceCOP;

    valid.push({ row, phone, service, servedAt, priceCOP });
  }

  // Teléfonos repetidos en el archivo son la MISMA clienta con varios
  // procedimientos: eso es lo normal en un histórico, no un error.
  const customers = new Map<string, string>(); // phone → nombre
  for (const v of valid) customers.set(v.phone, v.row.nombre);

  console.log(
    `  ✓ ${valid.length} procedimientos válidos, de ${customers.size} clientas`,
  );
  if (skipped.length > 0) {
    console.log(`  ✗ ${skipped.length} filas se saltan:`);
    for (const s of skipped.slice(0, 20)) {
      console.log(`      línea ${s.line}: ${s.why}`);
    }
    if (skipped.length > 20)
      console.log(`      … y ${skipped.length - 20} más`);
  }
  if (!staff) {
    console.log(
      '  ⚠️  No hay especialista activo: las citas quedan sin asignar.',
    );
  }

  const totalCOP = valid.reduce((a, v) => a + v.priceCOP, 0);
  console.log(`  Σ  ${totalCOP.toLocaleString('es-CO')} COP de histórico\n`);

  if (!COMMIT) {
    console.log('Simulación terminada. Nada se escribió.');
    console.log('Si el reporte se ve bien, vuelve a correrlo con --commit\n');
    return;
  }

  // ─── Escritura ────────────────────────────────────────────────────────────
  let createdCustomers = 0;
  let createdAppointments = 0;

  await prisma.$transaction(
    async (tx) => {
      const customerIdByPhone = new Map<string, string>();

      for (const [phone, name] of customers) {
        // La clienta se resuelve por teléfono, que ya es único por sede. Si ya
        // existe se le agregan los procedimientos; no se duplica.
        const existing = await tx.barberCustomer.findUnique({
          where: { branchId_phone: { branchId: BRANCH_ID!, phone } },
          select: { id: true },
        });
        if (existing) {
          customerIdByPhone.set(phone, existing.id);
          continue;
        }
        const created = await tx.barberCustomer.create({
          data: { tenantId: TENANT_ID!, branchId: BRANCH_ID!, name, phone },
          select: { id: true },
        });
        customerIdByPhone.set(phone, created.id);
        createdCustomers++;
      }

      for (const v of valid) {
        const customerId = customerIdByPhone.get(v.phone)!;
        const end = new Date(
          v.servedAt.getTime() + v.service.durationMin * 60_000,
        );

        const appointment = await tx.barberAppointment.create({
          data: {
            tenantId: TENANT_ID!,
            branchId: BRANCH_ID!,
            customerId,
            serviceId: v.service.id,
            staffId: staff?.id,
            scheduledAt: v.servedAt,
            scheduledEnd: end,
            // Nace ya completada: es histórico, no una cita por atender.
            status: 'completed',
            servedAt: v.servedAt,
            priceCOP: v.priceCOP,
            costCOP: v.service.costCOP,
            source: 'import',
            notes: v.row.nota || undefined,
          },
          select: { id: true },
        });

        await tx.barberAppointmentEvent.create({
          data: {
            tenantId: TENANT_ID!,
            branchId: BRANCH_ID!,
            appointmentId: appointment.id,
            kind: 'CREATED',
            summary: `Importado del histórico · ${v.service.name}`,
            note: `Archivo ${FILE}, línea ${v.row.line}`,
            detail: {
              servedAt: v.servedAt.toISOString(),
              priceCOP: v.priceCOP,
              importedFrom: 'csv',
            } as Prisma.InputJsonValue,
            userName: 'Importación',
          },
        });
        createdAppointments++;
      }

      // Los contadores se recalculan UNA vez al final, no por fila: son un
      // agregado sobre las citas que acaban de entrar.
      for (const customerId of customerIdByPhone.values()) {
        const agg = await tx.barberAppointment.aggregate({
          where: {
            customerId,
            status: { in: ['completed', 'COMPLETED', 'Completed'] },
          },
          _count: { _all: true },
          _max: { servedAt: true },
        });
        await tx.barberCustomer.update({
          where: { id: customerId },
          data: {
            totalVisits: agg._count._all,
            lastVisitAt: agg._max.servedAt ?? null,
          },
        });
      }
    },
    // Un histórico grande no cabe en el timeout por defecto de 5 s.
    { timeout: 120_000, maxWait: 20_000 },
  );

  console.log(`✓ ${createdCustomers} clientas nuevas`);
  console.log(`✓ ${createdAppointments} procedimientos cargados`);
  console.log(`✓ visitas y última visita recalculadas\n`);
}

main()
  .catch((e: unknown) => {
    console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
