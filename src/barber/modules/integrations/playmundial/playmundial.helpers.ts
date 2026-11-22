import { BadRequestException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';

/**
 * Piezas puras de la integración con Play Mundial (sin base de datos, para
 * poder probarlas solas).
 */

export const TOKEN_PREFIX = 'pmk_';

/** Token de servicio: 256 bits aleatorios. Solo el hash se guarda. */
export function generateToken(): {
  token: string;
  hash: string;
  prefix: string;
} {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, 8) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** El token del header `Authorization: Bearer …`, o null si no viene bien. */
export function bearerOf(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match || !match[1].startsWith(TOKEN_PREFIX)) return null;
  return match[1];
}

/** Ventana máxima que se puede pedir de una vez. */
export const MAX_WINDOW_MS = 8 * 24 * 3600 * 1000;
/** Por defecto: lo que acaba de pasar (turno que se alarga) y las próximas 48 h. */
const DEFAULT_BACK_MS = 6 * 3600 * 1000;
const DEFAULT_AHEAD_MS = 48 * 3600 * 1000;

function parseInstant(value: string, name: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`"${name}" no es una fecha válida (ISO 8601).`);
  }
  return d;
}

export function parseWindow(
  from: string | undefined,
  to: string | undefined,
  now: Date = new Date(),
): { from: Date; to: Date } {
  const start = from
    ? parseInstant(from, 'from')
    : new Date(now.getTime() - DEFAULT_BACK_MS);
  const end = to
    ? parseInstant(to, 'to')
    : new Date(start.getTime() + DEFAULT_BACK_MS + DEFAULT_AHEAD_MS);
  if (end <= start) {
    throw new BadRequestException('"to" debe ser posterior a "from".');
  }
  if (end.getTime() - start.getTime() > MAX_WINDOW_MS) {
    throw new BadRequestException('La ventana máxima es de 8 días.');
  }
  return { from: start, to: end };
}

/**
 * Estados donde la reserva puede abrir un turno de juego.
 *
 * `COMPLETED` entra a propósito: el administrador marca la reserva completada
 * al entrar la siguiente, o sea, a veces mientras el último partido de esa
 * reserva todavía se está jugando.
 * `PENDING` no: una reserva por aprobar todavía no es un hecho.
 */
const PLAYABLE = ['SCHEDULED', 'CONFIRMED', 'COMPLETED'];

export type PlayMundialOccurrence = {
  id: string;
  /** `updatedAt`: Play Mundial ignora una versión más vieja que la que ya tiene. */
  version: string;
  branchId: string;
  courtId: string;
  courtName: string;
  startsAt: string;
  endsAt: string;
  /** Estado tal cual está en Lynko, en mayúsculas. */
  status: string;
  /** ¿Puede abrir un turno de juego? (ver PLAYABLE). */
  playable: boolean;
  recurringBookingId: string | null;
  servedAt: string | null;
  customer: { id: string; name: string } | null;
};

type OccurrenceRow = {
  id: string;
  updatedAt: Date;
  branchId: string;
  serviceId: string;
  service: { name: string };
  scheduledAt: Date;
  scheduledEnd: Date;
  status: string;
  recurringBookingId: string | null;
  servedAt: Date | null;
  customer: { id: string; name: string } | null;
};

/**
 * Lo que Play Mundial necesita y nada más: sin teléfono, notas ni precios.
 * El estado se normaliza porque en la base conviven 'completed' y 'COMPLETED'.
 */
export function toOccurrence(row: OccurrenceRow): PlayMundialOccurrence {
  const status = row.status.toUpperCase();
  return {
    id: row.id,
    version: row.updatedAt.toISOString(),
    branchId: row.branchId,
    courtId: row.serviceId,
    courtName: row.service.name,
    startsAt: row.scheduledAt.toISOString(),
    endsAt: row.scheduledEnd.toISOString(),
    status,
    playable: PLAYABLE.includes(status),
    recurringBookingId: row.recurringBookingId,
    servedAt: row.servedAt ? row.servedAt.toISOString() : null,
    customer: row.customer
      ? { id: row.customer.id, name: row.customer.name }
      : null,
  };
}

/** Rango máximo del resumen por cliente: un trimestre alcanza para cierres de mes. */
export const MAX_SUMMARY_RANGE_MS = 93 * 24 * 3600 * 1000;

/** Rango obligatorio (`from` y `to`) del resumen por cliente. */
export function parseSummaryRange(
  from: string | undefined,
  to: string | undefined,
): { from: Date; to: Date } {
  if (!from || !to) {
    throw new BadRequestException('"from" y "to" son obligatorios.');
  }
  const start = parseInstant(from, 'from');
  const end = parseInstant(to, 'to');
  if (end <= start) {
    throw new BadRequestException('"to" debe ser posterior a "from".');
  }
  if (end.getTime() - start.getTime() > MAX_SUMMARY_RANGE_MS) {
    throw new BadRequestException('El rango máximo es de 93 días.');
  }
  return { from: start, to: end };
}

export type CustomerSummary = {
  customerId: string;
  name: string;
  /** SCHEDULED + CONFIRMED + COMPLETED: reservas que valieron. */
  reservations: number;
  /** COMPLETED: el negocio las marcó como utilizadas (visitas). */
  completed: number;
  noShows: number;
  cancelled: number;
  /** Minutos de las reservas COMPLETED. */
  minutesCompleted: number;
  lastServedAt: string | null;
};

type SummaryRow = {
  status: string;
  scheduledAt: Date;
  scheduledEnd: Date;
  servedAt: Date | null;
  customer: { id: string; name: string } | null;
};

/**
 * Cuenta por cliente. Las reservas sin cliente se descartan: sin id no hay a
 * quién sumarle. PENDING y REJECTED no cuentan en nada (no son un hecho).
 */
export function summarizeByCustomer(rows: SummaryRow[]): CustomerSummary[] {
  const map = new Map<string, CustomerSummary>();
  for (const row of rows) {
    if (!row.customer) continue;
    const status = row.status.toUpperCase();
    const entry = map.get(row.customer.id) ?? {
      customerId: row.customer.id,
      name: row.customer.name,
      reservations: 0,
      completed: 0,
      noShows: 0,
      cancelled: 0,
      minutesCompleted: 0,
      lastServedAt: null,
    };
    if (PLAYABLE.includes(status)) entry.reservations += 1;
    if (status === 'COMPLETED') {
      entry.completed += 1;
      entry.minutesCompleted += Math.round(
        (row.scheduledEnd.getTime() - row.scheduledAt.getTime()) / 60_000,
      );
      const served = (row.servedAt ?? row.scheduledAt).toISOString();
      if (!entry.lastServedAt || served > entry.lastServedAt) {
        entry.lastServedAt = served;
      }
    } else if (status === 'NO_SHOW') entry.noShows += 1;
    else if (status === 'CANCELLED') entry.cancelled += 1;
    map.set(row.customer.id, entry);
  }
  return [...map.values()].sort(
    (a, b) => b.completed - a.completed || a.name.localeCompare(b.name),
  );
}
