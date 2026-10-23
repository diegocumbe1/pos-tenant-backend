import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Sincronización In Move → Lynko: los deportistas entran como clientes.
 *
 * Una sola implementación para los dos caminos: el botón "Sincronizar con In
 * Move" de Ajustes (que trae los datos de la API de In Move) y el script
 * `scripts/import-inmove-customers.ts` (que los lee de un archivo exportado).
 *
 * NO DUPLICA. Cada cliente sincronizado lleva la etiqueta `inmove:<código>`.
 * Correrla dos veces da "sin cambios" la segunda. Si un deportista todavía no
 * tiene etiqueta pero ya existe un cliente con su mismo nombre (lo creó la
 * recepción a mano), se ENLAZA ese cliente en vez de crear otro.
 *
 * SOLO TOCA LO SUYO. In Move manda el nombre, si está activo, sus etiquetas
 * "In Move…" y un bloque de notas entre marcas. El teléfono, las notas y
 * etiquetas escritas en Lynko, las citas y los cobros no se tocan nunca.
 *
 * NO BORRA. Un deportista que ya no viene de In Move se reporta, pero su
 * cliente se queda: puede tener pagos y asistencias.
 */

export type InMoveAthlete = {
  id: string;
  code: string;
  name: string;
  document: string | null;
  birthDate: string;
  sex: string;
  category: string | null;
  legacyGroup: string | null;
  sport: string | null;
  position: string | null;
  disabled: boolean;
  createdAt: string;
  latestAssessmentId: string | null;
  latestAssessedOn: string | null;
  assessmentsCount: number;
  groups: { id: string; name: string; joinedAt: string }[];
};

export type InMoveExport = {
  source: 'in-move';
  exportedAt: string;
  athletes: InMoveAthlete[];
};

export type InMoveSyncAction = 'create' | 'link' | 'update' | 'unchanged';

export type InMoveSyncReport = {
  committed: boolean;
  total: number;
  created: number;
  linked: number;
  updated: number;
  unchanged: number;
  /** Clientes creados sin teléfono real: hay que completarlo en Lynko. */
  withoutPhone: number;
  /** Clientes con etiqueta de In Move que ya no vienen en la exportación. */
  missingInSource: { customerId: string; name: string; code: string }[];
  items: {
    code: string;
    name: string;
    action: InMoveSyncAction;
    changes: string[];
  }[];
};

/** Grupos-texto viejos que no son un grupo real (ver backfill-groups de In Move). */
const NOT_GROUPS = new Set(['Libre', 'Juvenil']);
const MANAGED_TAG = 'In Move';
const NOTES_START = '── In Move ──';
const NOTES_END = '── /In Move ──';

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

const codeTag = (code: string) => `inmove:${code}`;

/** Las etiquetas que pone In Move. Todas empiezan por "In Move" o "inmove:". */
function isManagedTag(tag: string): boolean {
  return (
    tag === MANAGED_TAG ||
    tag.startsWith(`${MANAGED_TAG}: `) ||
    tag.startsWith('inmove:')
  );
}

function managedTags(a: InMoveAthlete): string[] {
  const groups = a.groups.length
    ? a.groups.map((g) => g.name)
    : a.legacyGroup && !NOT_GROUPS.has(a.legacyGroup)
      ? [a.legacyGroup]
      : [];
  return [
    MANAGED_TAG,
    codeTag(a.code),
    ...groups.map((g) => `${MANAGED_TAG}: ${g}`),
    ...(a.category ? [`${MANAGED_TAG}: ${a.category}`] : []),
    ...(a.sport ? [`${MANAGED_TAG}: ${a.sport}`] : []),
  ];
}

/**
 * Teléfono provisional SIN DÍGITOS. En Lynko el teléfono es obligatorio y único
 * por sede, pero In Move no lo guarda. Con letras, cualquier enlace de WhatsApp
 * sale vacío en vez de escribirle a un número inventado.
 */
export function placeholderPhone(code: string): string {
  const letters = code.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
  return `sin-telefono-${letters}`;
}

export function isPlaceholderPhone(phone: string): boolean {
  return phone.startsWith('sin-telefono-');
}

function ageOn(birthDate: string, today: Date): number {
  const [y, m, d] = birthDate.split('-').map(Number);
  let age = today.getUTCFullYear() - y;
  if (
    today.getUTCMonth() + 1 < m ||
    (today.getUTCMonth() + 1 === m && today.getUTCDate() < d)
  ) {
    age -= 1;
  }
  return age;
}

/** El bloque de notas que es de In Move. Se reemplaza entero en cada pasada. */
function notesBlock(a: InMoveAthlete, fichaBaseUrl?: string): string {
  const lines = [
    `Código In Move: ${a.code}`,
    a.document ? `Documento: ${a.document}` : null,
    `Nacimiento: ${a.birthDate} (${ageOn(a.birthDate, new Date())} años) · ${a.sex === 'F' ? 'F' : 'M'}`,
    a.category ? `Categoría: ${a.category}` : null,
    a.sport
      ? `Deporte: ${a.sport}${a.position ? ` · ${a.position}` : ''}`
      : null,
    `Valoraciones: ${a.assessmentsCount}${a.latestAssessedOn ? ` · última ${a.latestAssessedOn}` : ''}`,
    a.latestAssessmentId && fichaBaseUrl
      ? `Ficha: ${fichaBaseUrl.replace(/\/$/, '')}/ficha/${a.latestAssessmentId}`
      : null,
  ].filter(Boolean);
  return [NOTES_START, ...lines, NOTES_END].join('\n');
}

/** Las notas con el bloque de In Move puesto (o reemplazado), sin tocar el resto. */
function mergeNotes(current: string | null, block: string): string {
  const text = current ?? '';
  const start = text.indexOf(NOTES_START);
  const end = text.indexOf(NOTES_END);
  if (start >= 0 && end > start) {
    return (
      text.slice(0, start) +
      block +
      text.slice(end + NOTES_END.length)
    ).trim();
  }
  return text.trim() ? `${text.trim()}\n\n${block}` : block;
}

function sameTags(a: string[], b: string[]): boolean {
  return (
    a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')
  );
}

export async function syncInMoveAthletes(
  prisma: PrismaClient,
  scope: { tenantId: string; branchId: string },
  payload: InMoveExport,
  opts: { commit: boolean; fichaBaseUrl?: string },
): Promise<InMoveSyncReport> {
  if (payload?.source !== 'in-move' || !Array.isArray(payload.athletes)) {
    throw new Error('El archivo no es una exportación de In Move');
  }

  const customers = await prisma.barberCustomer.findMany({
    where: { tenantId: scope.tenantId, branchId: scope.branchId },
    select: {
      id: true,
      name: true,
      phone: true,
      notes: true,
      tags: true,
      isActive: true,
    },
  });
  const byCode = new Map<string, (typeof customers)[number]>();
  const byName = new Map<string, (typeof customers)[number]>();
  for (const c of customers) {
    const tag = c.tags.find((t) => t.startsWith('inmove:'));
    if (tag) byCode.set(tag.slice('inmove:'.length), c);
    // Solo se enlaza por nombre a quien todavía no viene de In Move: si dos
    // deportistas se llaman igual, el segundo no se monta sobre el primero.
    else byName.set(normalizeName(c.name), c);
  }

  const report: InMoveSyncReport = {
    committed: opts.commit,
    total: payload.athletes.length,
    created: 0,
    linked: 0,
    updated: 0,
    unchanged: 0,
    withoutPhone: 0,
    missingInSource: [],
    items: [],
  };
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  const seenCodes = new Set<string>();

  for (const raw of payload.athletes) {
    // Espacios dobles o sobrantes que se colaron al digitar en In Move.
    const a = { ...raw, name: raw.name.trim().replace(/\s+/g, ' ') };
    seenCodes.add(a.code);
    const desiredManaged = managedTags(a);
    const block = notesBlock(a, opts.fichaBaseUrl);
    const existing = byCode.get(a.code) ?? null;
    const named = existing ? null : (byName.get(normalizeName(a.name)) ?? null);
    const target = existing ?? named;

    if (!target) {
      report.created += 1;
      report.withoutPhone += 1;
      report.items.push({
        code: a.code,
        name: a.name,
        action: 'create',
        changes: [],
      });
      writes.push(
        prisma.barberCustomer.create({
          data: {
            tenantId: scope.tenantId,
            branchId: scope.branchId,
            name: a.name,
            phone: placeholderPhone(a.code),
            notes: block,
            tags: desiredManaged,
            isActive: !a.disabled,
            // "Cliente desde": cuando entró a In Move, no cuando se sincronizó.
            createdAt: new Date(a.createdAt),
          },
        }),
      );
      continue;
    }

    if (named) byName.delete(normalizeName(a.name)); // no enlazar dos veces el mismo
    const tags = [
      ...target.tags.filter((t) => !isManagedTag(t)),
      ...desiredManaged,
    ];
    const notes = mergeNotes(target.notes, block);
    const changes: string[] = [];
    if (target.name !== a.name)
      changes.push(`nombre: "${target.name}" → "${a.name}"`);
    if (target.isActive === a.disabled)
      changes.push(a.disabled ? 'inactivo' : 'activo');
    if (!sameTags(target.tags, tags)) changes.push('etiquetas');
    if ((target.notes ?? '') !== notes) changes.push('notas In Move');
    if (isPlaceholderPhone(target.phone)) report.withoutPhone += 1;

    const action: InMoveSyncAction = named
      ? 'link'
      : changes.length
        ? 'update'
        : 'unchanged';
    if (action === 'link') report.linked += 1;
    else if (action === 'update') report.updated += 1;
    else report.unchanged += 1;
    report.items.push({ code: a.code, name: a.name, action, changes });

    if (action !== 'unchanged') {
      writes.push(
        prisma.barberCustomer.update({
          where: { id: target.id },
          data: { name: a.name, isActive: !a.disabled, tags, notes },
        }),
      );
    }
  }

  for (const [code, c] of byCode) {
    if (!seenCodes.has(code)) {
      report.missingInSource.push({ customerId: c.id, name: c.name, code });
    }
  }

  // Todo o nada: una sincronización a medias deja clientes repartidos entre
  // "ya enlazado" y "por crear" y la siguiente pasada los duplicaría.
  if (opts.commit && writes.length) await prisma.$transaction(writes);
  return report;
}
