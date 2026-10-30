import { addMonthsDay, planCycle, toCalendarDay, toPlanDay, usedInCycle } from './plan-cycle';

describe('planCycle', () => {
  it('cuenta el mes desde el inicio del plan', () => {
    expect(planCycle('2026-10-26', '2026-10-30')).toEqual({ start: '2026-10-26', end: '2026-11-25' });
    expect(planCycle('2026-10-26', '2026-11-25')).toEqual({ start: '2026-10-26', end: '2026-11-25' });
    expect(planCycle('2026-10-26', '2026-11-26')).toEqual({ start: '2026-11-26', end: '2026-12-25' });
    expect(planCycle('2026-10-26', '2027-01-10')).toEqual({ start: '2026-12-26', end: '2027-01-25' });
  });

  it('un inicio el 31 cae al último día de los meses cortos', () => {
    expect(addMonthsDay('2026-01-31', 1)).toBe('2026-02-28');
    expect(planCycle('2026-01-31', '2026-02-27')).toEqual({ start: '2026-01-31', end: '2026-02-27' });
    expect(planCycle('2026-01-31', '2026-02-28')).toEqual({ start: '2026-02-28', end: '2026-03-30' });
  });

  it('sin inicio usa el mes calendario', () => {
    expect(planCycle(null, '2026-02-14')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('cuenta solo las visitas del mes de plan', () => {
    const visits = ['2026-10-27', '2026-11-03', '2026-11-25', '2026-11-26'];
    expect(usedInCycle('2026-10-26', '2026-11-10', visits).used).toBe(3);
    expect(usedInCycle('2026-10-26', '2026-12-01', visits).used).toBe(1);
  });
});

describe('congelaciones', () => {
  // Plan desde el 26-oct; se congela del 5 al 14 de noviembre (10 días).
  const freeze = [{ start: '2026-11-05', end: '2026-11-14' }];

  it('el mes que tuvo la congelación dura 10 días más', () => {
    expect(planCycle('2026-10-26', '2026-11-20', freeze)).toEqual({ start: '2026-10-26', end: '2026-12-05' });
    // El siguiente arranca corrido 10 días.
    expect(planCycle('2026-10-26', '2026-12-06', freeze)).toEqual({ start: '2026-12-06', end: '2027-01-04' });
  });

  it('antes de la congelación nada cambia', () => {
    expect(planCycle('2026-10-26', '2026-11-01', freeze).start).toBe('2026-10-26');
    expect(toPlanDay('2026-11-04', freeze)).toBe('2026-11-04');
  });

  it('ida y vuelta entre calendario y tiempo de plan', () => {
    expect(toPlanDay('2026-11-15', freeze)).toBe('2026-11-05');
    expect(toCalendarDay('2026-11-05', freeze)).toBe('2026-11-15');
  });

  it('las visitas cuentan en el mes corrido', () => {
    const visits = ['2026-10-30', '2026-11-03', '2026-11-20', '2026-12-04', '2026-12-06'];
    expect(usedInCycle('2026-10-26', '2026-12-04', visits, freeze).used).toBe(4);
  });
});
