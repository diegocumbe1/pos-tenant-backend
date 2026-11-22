import { BadRequestException } from '@nestjs/common';
import {
  bearerOf,
  generateToken,
  hashToken,
  MAX_WINDOW_MS,
  parseSummaryRange,
  parseWindow,
  summarizeByCustomer,
  toOccurrence,
} from './playmundial.helpers';

describe('token de servicio', () => {
  it('genera tokens distintos con prefijo y hash que coincide', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.startsWith('pmk_')).toBe(true);
    expect(a.hash).toBe(hashToken(a.token));
    expect(a.prefix).toBe(a.token.slice(0, 8));
    // el hash no deja ver el token
    expect(a.hash).not.toContain(a.token);
  });

  it('lee el Bearer solo si es de este tipo', () => {
    const { token } = generateToken();
    expect(bearerOf(`Bearer ${token}`)).toBe(token);
    expect(bearerOf(`bearer ${token}`)).toBe(token);
    expect(bearerOf(token)).toBeNull();
    expect(bearerOf('Bearer otra-cosa')).toBeNull();
    expect(bearerOf(undefined)).toBeNull();
    expect(bearerOf('Bearer')).toBeNull();
  });
});

describe('parseWindow', () => {
  const now = new Date('2026-11-17T20:00:00.000Z');

  it('por defecto: 6 h atrás y 48 h adelante', () => {
    const w = parseWindow(undefined, undefined, now);
    expect(w.from.toISOString()).toBe('2026-11-17T14:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-11-19T20:00:00.000Z');
  });

  it('acepta una ventana explícita', () => {
    const w = parseWindow('2026-11-18T00:00:00Z', '2026-11-19T00:00:00Z', now);
    expect(w.to.getTime() - w.from.getTime()).toBe(24 * 3600 * 1000);
  });

  it('rechaza fechas inválidas, ventana invertida o demasiado larga', () => {
    expect(() => parseWindow('no-es-fecha', undefined, now)).toThrow(
      BadRequestException,
    );
    expect(() =>
      parseWindow('2026-11-19T00:00:00Z', '2026-11-18T00:00:00Z', now),
    ).toThrow(BadRequestException);
    const from = new Date(now.getTime());
    const to = new Date(now.getTime() + MAX_WINDOW_MS + 1);
    expect(() =>
      parseWindow(from.toISOString(), to.toISOString(), now),
    ).toThrow(BadRequestException);
  });
});

describe('toOccurrence', () => {
  const base = {
    id: 'apt1',
    updatedAt: new Date('2026-11-17T10:00:00.000Z'),
    branchId: 'br1',
    serviceId: 'svc1',
    service: { name: 'Cancha 1' },
    scheduledAt: new Date('2026-11-17T23:00:00.000Z'),
    scheduledEnd: new Date('2026-11-18T00:00:00.000Z'),
    status: 'scheduled',
    recurringBookingId: null,
    servedAt: null,
    customer: { id: 'c1', name: 'Ana' },
  };

  it('normaliza el estado y marca los que pueden abrir turno', () => {
    expect(toOccurrence(base).status).toBe('SCHEDULED');
    expect(toOccurrence(base).playable).toBe(true);
    expect(toOccurrence({ ...base, status: 'Completed' }).playable).toBe(true);
    for (const status of ['PENDING', 'CANCELLED', 'REJECTED', 'NO_SHOW']) {
      expect(toOccurrence({ ...base, status }).playable).toBe(false);
    }
  });

  it('no filtra datos de más y admite reserva sin cliente', () => {
    const out = toOccurrence({ ...base, customer: null });
    expect(out.customer).toBeNull();
    expect(Object.keys(out)).not.toContain('priceCOP');
    expect(JSON.stringify(toOccurrence(base))).not.toContain('phone');
    expect(out.courtId).toBe('svc1');
    expect(out.version).toBe('2026-11-17T10:00:00.000Z');
  });
});

describe('resumen por cliente', () => {
  const at = (h: number) => new Date(`2026-11-10T${String(h).padStart(2, '0')}:00:00.000Z`);
  const row = (status: string, h: number, id: string | null) => ({
    status,
    scheduledAt: at(h),
    scheduledEnd: at(h + 1),
    servedAt: null,
    customer: id ? { id, name: `Cliente ${id}` } : null,
  });

  it('cuenta por estado, suma minutos de las utilizadas y descarta sin cliente', () => {
    const out = summarizeByCustomer([
      row('completed', 10, 'a'),
      row('COMPLETED', 12, 'a'),
      row('SCHEDULED', 14, 'a'),
      row('NO_SHOW', 16, 'a'),
      row('CANCELLED', 18, 'b'),
      row('PENDING', 19, 'b'),
      row('COMPLETED', 20, null),
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((c) => c.customerId === 'a')!;
    expect(a).toMatchObject({ reservations: 3, completed: 2, noShows: 1, minutesCompleted: 120 });
    const b = out.find((c) => c.customerId === 'b')!;
    expect(b).toMatchObject({ reservations: 0, completed: 0, cancelled: 1 });
  });

  it('ordena por utilizadas y exige un rango acotado', () => {
    const out = summarizeByCustomer([row('COMPLETED', 9, 'x'), row('COMPLETED', 10, 'y'), row('COMPLETED', 11, 'y')]);
    expect(out[0].customerId).toBe('y');
    expect(() => parseSummaryRange(undefined, '2026-12-01')).toThrow(BadRequestException);
    expect(() => parseSummaryRange('2026-01-01', '2026-12-01')).toThrow(BadRequestException);
    expect(parseSummaryRange('2026-11-01', '2026-12-01').to.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});
