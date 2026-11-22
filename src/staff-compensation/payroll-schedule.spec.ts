import {
  expectedPerPayDay,
  payDaysInMonth,
  payrollOccurrences,
  unpaidOccurrences,
} from './payroll-schedule';

const quincenal = { payFrequency: 'BIWEEKLY' as const, payDays: [], startDay: '2026-11-01' };

describe('calendario de nómina', () => {
  it('arranca el 1 pero se paga el 15 y el fin de mes', () => {
    expect(payDaysInMonth(quincenal, '2026-11')).toEqual(['2026-11-15', '2026-11-30']);
    expect(payDaysInMonth(quincenal, '2026-02')).toEqual([]); // antes del arranque
    expect(payDaysInMonth({ ...quincenal, startDay: '2026-01-01' }, '2026-02')).toEqual(['2026-02-15', '2026-02-28']);
  });

  it('no cuenta días de pago anteriores al arranque', () => {
    const late = { ...quincenal, startDay: '2026-11-20' };
    expect(payDaysInMonth(late, '2026-11')).toEqual(['2026-11-30']);
  });

  it('respeta los días propios del contrato y el 31 es fin de mes', () => {
    const s = { payFrequency: 'MONTHLY' as const, payDays: [5], startDay: '2026-01-01' };
    expect(payDaysInMonth(s, '2026-04')).toEqual(['2026-04-05']);
    expect(payDaysInMonth({ ...s, payDays: [31] }, '2026-04')).toEqual(['2026-04-30']);
  });

  it('semanal y diario no tienen calendario por días del mes', () => {
    expect(payrollOccurrences({ payFrequency: 'WEEKLY', payDays: [], startDay: '2026-01-01' }, '2026-01-01', '2026-03-01')).toEqual([]);
  });

  it('recorre varios meses en orden', () => {
    expect(payrollOccurrences(quincenal, '2026-11-20', '2027-01-20')).toEqual([
      '2026-11-30', '2026-12-15', '2026-12-31', '2027-01-15',
    ]);
  });

  it('los pagos ya hechos cubren las primeras fechas de su mes', () => {
    // Dos pagos en noviembre cubren el 15 y el 30; sigue diciembre.
    const paid = new Map([['2026-11', 2]]);
    expect(unpaidOccurrences(quincenal, '2026-11-01', '2026-12-31', paid)).toEqual(['2026-12-15', '2026-12-31']);
    // Un solo pago deja pendiente el fin de mes.
    expect(unpaidOccurrences(quincenal, '2026-11-01', '2026-11-30', new Map([['2026-11', 1]]))).toEqual(['2026-11-30']);
  });
});

describe('expectedPerPayDay', () => {
  const base = { baseAmount: 500000, defaultBonuses: null, hourlyRate: null, expectedHoursPerPeriod: null };
  it('fijo, fijo + bonos, por horas y comisión', () => {
    expect(expectedPerPayDay({ ...base, contractType: 'FIXED' })).toBe(500000);
    expect(expectedPerPayDay({ ...base, contractType: 'FIXED_PLUS_BONUS', defaultBonuses: 50000 })).toBe(550000);
    expect(expectedPerPayDay({ ...base, contractType: 'HOURLY', hourlyRate: 10000, expectedHoursPerPeriod: 20 })).toBe(200000);
    expect(expectedPerPayDay({ ...base, baseAmount: 0, contractType: 'COMMISSION' })).toBeNull();
    expect(expectedPerPayDay({ ...base, contractType: 'COMMISSION' })).toBe(500000);
  });
});
