import { parseAlexaDate, parseAlexaDuration } from './alexa-dates';

describe('fechas de Alexa', () => {
  const now = new Date('2026-11-05T15:00:00Z');

  it.each([
    ['2026-11-05', '2026-11-05', '2026-11-05', 'hoy'],
    ['2026-11-04', '2026-11-04', '2026-11-04', 'ayer'],
    ['2026-11-06', '2026-11-06', '2026-11-06', 'mañana'],
    ['2026-10-03', '2026-10-03', '2026-10-03', 'el 3 de octubre'],
    ['2026-W45', '2026-11-02', '2026-11-08', 'esta semana'],
    ['2026-W44', '2026-10-26', '2026-11-01', 'la semana del 26 de octubre'],
    [
      '2026-W45-WE',
      '2026-11-07',
      '2026-11-08',
      'el fin de semana del 7 de noviembre',
    ],
    ['2026-11', '2026-11-01', '2026-11-30', 'este mes'],
    ['2026-02', '2026-02-01', '2026-02-28', 'en febrero'],
    ['2026', '2026-01-01', '2026-12-31', 'en 2026'],
  ])('%s', (value, from, to, label) => {
    expect(parseAlexaDate(value, now)).toEqual({ from, to, label });
  });

  it('no inventa un rango para lo que no entiende', () => {
    expect(parseAlexaDate('2026-WI', now)).toBeNull();
    expect(parseAlexaDate(undefined, now)).toBeNull();
  });

  it('las duraciones cuentan hacia atrás y nombran los días', () => {
    expect(parseAlexaDuration('P2W', now)).toEqual({
      from: '2026-10-22',
      to: '2026-11-05',
      label: 'en los últimos 14 días',
    });
    expect(parseAlexaDuration('PT5H', now)).toBeNull();
  });
});
