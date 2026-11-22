import {
  addBusinessDaysCO,
  colombianHolidays,
  isBusinessDayCO,
} from './business-days';

describe('festivos de Colombia', () => {
  it('2026: los fijos, los de Ley Emiliani y los de Semana Santa', () => {
    const h = colombianHolidays(2026);
    // Fijos
    expect(h.has('2026-05-01')).toBe(true);
    expect(h.has('2026-07-20')).toBe(true);
    expect(h.has('2026-12-25')).toBe(true);
    // 1 nov (domingo) → lunes 2; 11 nov (miércoles) → lunes 16
    expect(h.has('2026-11-02')).toBe(true);
    expect(h.has('2026-11-16')).toBe(true);
    expect(h.has('2026-11-11')).toBe(false);
    // Pascua 2026 = 5 abr → jueves 2 y viernes 3 santos
    expect(h.has('2026-04-02')).toBe(true);
    expect(h.has('2026-04-03')).toBe(true);
    // Ascensión (+43) lun 18 may; Corpus (+64) lun 8 jun; Sagrado Corazón (+71) lun 15 jun
    expect(h.has('2026-05-18')).toBe(true);
    expect(h.has('2026-06-08')).toBe(true);
    expect(h.has('2026-06-15')).toBe(true);
  });

  it('2027: Pascua el 28 mar', () => {
    const h = colombianHolidays(2027);
    expect(h.has('2027-03-25')).toBe(true);
    expect(h.has('2027-03-26')).toBe(true);
  });
});

describe('días hábiles', () => {
  it('pagado el sábado 21 nov 2026, llega el lunes 23', () => {
    expect(addBusinessDaysCO('2026-11-21', 1)).toBe('2026-11-23');
  });

  it('un viernes + 1 salta el fin de semana', () => {
    expect(addBusinessDaysCO('2026-11-20', 1)).toBe('2026-11-23');
  });

  it('salta el festivo: viernes 13 nov + 1 = martes 17 (el lunes 16 es festivo)', () => {
    expect(addBusinessDaysCO('2026-11-13', 1)).toBe('2026-11-17');
  });

  it('0 días es el mismo día y 2 días cuenta dos hábiles', () => {
    expect(addBusinessDaysCO('2026-11-23', 0)).toBe('2026-11-23');
    expect(addBusinessDaysCO('2026-11-23', 2)).toBe('2026-11-25');
  });

  it('isBusinessDayCO', () => {
    expect(isBusinessDayCO('2026-11-21')).toBe(false); // sábado
    expect(isBusinessDayCO('2026-11-16')).toBe(false); // festivo
    expect(isBusinessDayCO('2026-11-23')).toBe(true);
  });
});
