import {
  calendarDayCO,
  diffCalendarDaysCO,
  formatDateCO,
  formatDateLongCO,
} from './date.util';

describe('date.util (hora Colombia)', () => {
  describe('calendarDayCO', () => {
    it('usa el día colombiano, no el UTC', () => {
      // 2026-08-11T02:00Z son las 21:00 del 10 de agosto en Colombia (UTC−5).
      expect(calendarDayCO('2026-08-11T02:00:00.000Z')).toBe('2026-08-10');
    });

    it('no se corre con el TZ del proceso', () => {
      const original = process.env.TZ;
      process.env.TZ = 'UTC';
      try {
        expect(calendarDayCO('2026-08-11T02:00:00.000Z')).toBe('2026-08-10');
      } finally {
        process.env.TZ = original;
      }
    });
  });

  describe('diffCalendarDaysCO', () => {
    const due = '2026-08-10T05:00:00.000Z'; // 10/08/2026 00:00 en Colombia

    it('da el mismo número a cualquier hora del mismo día calendario', () => {
      // Este es el caso que rompía con ceil(diffMs / 24h): a las 08:00 daba 5 y
      // a las 20:00 daba 4, así que dos clientes contactados el mismo día
      // recibían cuentas distintas.
      const morning = diffCalendarDaysCO('2026-08-06T13:00:00.000Z', due); // 08:00 CO
      const evening = diffCalendarDaysCO('2026-08-07T01:00:00.000Z', due); // 20:00 CO del 6
      expect(morning).toBe(4);
      expect(evening).toBe(4);
    });

    it('es negativo cuando ya venció', () => {
      expect(diffCalendarDaysCO('2026-08-13T15:00:00.000Z', due)).toBe(-3);
    });

    it('es cero el día del vencimiento', () => {
      expect(diffCalendarDaysCO('2026-08-10T23:00:00.000Z', due)).toBe(0);
    });

    it('cuenta los días de holgura entre vencimiento y suspensión', () => {
      expect(diffCalendarDaysCO(due, '2026-08-15T05:00:00.000Z')).toBe(5);
    });
  });

  describe('formato', () => {
    it('formatea corto y largo en español de Colombia', () => {
      expect(formatDateCO('2026-08-10T05:00:00.000Z')).toBe('10/08/2026');
      expect(formatDateLongCO('2026-08-10T05:00:00.000Z')).toBe(
        'lunes, 10 de agosto de 2026',
      );
    });
  });
});
