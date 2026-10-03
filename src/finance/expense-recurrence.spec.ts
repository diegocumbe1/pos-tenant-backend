import { occurrencesBetween } from './expense-recurrence';

describe('occurrencesBetween', () => {
  it('mensual: mismo día cada mes', () => {
    expect(
      occurrencesBetween(
        { frequency: 'MONTHLY', anchorDay: '2026-08-05' },
        '2026-08-01',
        '2026-11-30',
      ),
    ).toEqual(['2026-08-05', '2026-09-05', '2026-10-05', '2026-11-05']);
  });

  it('mensual el 31: cae al último día y vuelve al 31', () => {
    expect(
      occurrencesBetween(
        { frequency: 'MONTHLY', anchorDay: '2026-01-31' },
        '2026-01-01',
        '2026-05-31',
      ),
    ).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
  });

  it('no genera nada antes del ancla', () => {
    expect(
      occurrencesBetween(
        { frequency: 'MONTHLY', anchorDay: '2026-10-05' },
        '2026-01-01',
        '2026-10-31',
      ),
    ).toEqual(['2026-10-05']);
  });

  it('ancla vieja: solo las ocurrencias del rango', () => {
    expect(
      occurrencesBetween(
        { frequency: 'MONTHLY', anchorDay: '2026-01-10' },
        '2026-10-01',
        '2026-11-30',
      ),
    ).toEqual(['2026-10-10', '2026-11-10']);
  });

  it('respeta la fecha de fin', () => {
    expect(
      occurrencesBetween(
        { frequency: 'MONTHLY', anchorDay: '2026-08-05', endsOn: '2026-09-30' },
        '2026-08-01',
        '2026-12-31',
      ),
    ).toEqual(['2026-08-05', '2026-09-05']);
  });

  it('quincenal: dos veces al mes', () => {
    expect(
      occurrencesBetween(
        { frequency: 'BIWEEKLY', anchorDay: '2026-10-05' },
        '2026-10-01',
        '2026-11-30',
      ),
    ).toEqual(['2026-10-05', '2026-10-20', '2026-11-05', '2026-11-20']);
  });

  it('quincenal el 15: el 15 y el último día', () => {
    expect(
      occurrencesBetween(
        { frequency: 'BIWEEKLY', anchorDay: '2026-02-15' },
        '2026-02-01',
        '2026-03-31',
      ),
    ).toEqual(['2026-02-15', '2026-02-28', '2026-03-15', '2026-03-30']);
  });

  it('semanal: salta a la primera ocurrencia del rango', () => {
    expect(
      occurrencesBetween(
        { frequency: 'WEEKLY', anchorDay: '2026-01-02' },
        '2026-10-01',
        '2026-10-20',
      ),
    ).toEqual(['2026-10-02', '2026-10-09', '2026-10-16']);
  });

  it('anual', () => {
    expect(
      occurrencesBetween(
        { frequency: 'ANNUAL', anchorDay: '2025-03-10' },
        '2025-01-01',
        '2027-12-31',
      ),
    ).toEqual(['2025-03-10', '2026-03-10', '2027-03-10']);
  });

  it('cruza el año', () => {
    expect(
      occurrencesBetween(
        { frequency: 'MONTHLY', anchorDay: '2026-11-10' },
        '2026-11-01',
        '2027-02-28',
      ),
    ).toEqual(['2026-11-10', '2026-12-10', '2027-01-10', '2027-02-10']);
  });

  it('único no se repite', () => {
    expect(
      occurrencesBetween(
        { frequency: 'ONE_TIME', anchorDay: '2026-10-05' },
        '2026-01-01',
        '2026-12-31',
      ),
    ).toEqual([]);
  });
});
