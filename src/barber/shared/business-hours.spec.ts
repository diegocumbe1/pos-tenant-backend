import { BusinessHours, isWithinBusinessHours } from './business-hours';

// L–V 08:00–12:00 · Sáb 08:00–10:00 · Dom cerrado. Lunes con corte 12–14.
const HOURS: BusinessHours = {
  monday: [
    { start: '08:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ],
  tuesday: [{ start: '08:00', end: '12:00' }],
  wednesday: [{ start: '08:00', end: '12:00' }],
  thursday: [{ start: '08:00', end: '12:00' }],
  friday: [{ start: '08:00', end: '12:00' }],
  saturday: [{ start: '08:00', end: '10:00' }],
  sunday: [],
};

// Hora Colombia (UTC-5) → instante.
const co = (iso: string) => new Date(`${iso}-05:00`);
const within = (from: string, to: string) =>
  isWithinBusinessHours(HOURS, co(from), co(to));

describe('isWithinBusinessHours', () => {
  it('acepta un rango dentro de un turno', () => {
    // 2026-11-02 es lunes.
    expect(within('2026-11-02T08:00:00', '2026-11-02T09:00:00')).toBe(true);
    expect(within('2026-11-02T11:00:00', '2026-11-02T12:00:00')).toBe(true);
  });

  it('rechaza lo que cruza el corte o pasa del cierre', () => {
    expect(within('2026-11-02T11:30:00', '2026-11-02T12:30:00')).toBe(false);
    expect(within('2026-11-02T07:30:00', '2026-11-02T08:30:00')).toBe(false);
  });

  it('respeta el horario corto del sábado y el domingo cerrado', () => {
    // 2026-11-07 sábado, 2026-11-08 domingo.
    expect(within('2026-11-07T09:00:00', '2026-11-07T10:00:00')).toBe(true);
    expect(within('2026-11-07T09:30:00', '2026-11-07T10:30:00')).toBe(false);
    expect(within('2026-11-08T09:00:00', '2026-11-08T10:00:00')).toBe(false);
  });

  it('usa el día colombiano, no el UTC', () => {
    // Lunes 17:00–18:00 CO es lunes 22:00–23:00 UTC: vale por el turno de la
    // tarde del lunes. El martes a esa hora no (martes cierra a las 12).
    expect(within('2026-11-02T17:00:00', '2026-11-02T18:00:00')).toBe(true);
    expect(within('2026-11-03T17:00:00', '2026-11-03T18:00:00')).toBe(false);
  });
});
