import { ReportPeriod } from './assistant.types';
import {
  parsePeriod,
  parsePeriodText,
  periodLabel,
  periodRange,
} from './report-period';

describe('report period', () => {
  describe('parsePeriod', () => {
    it.each([
      ['ayer', 'yesterday'],
      ['de ayer', 'yesterday'],
      ['el día de ayer', 'yesterday'],
      ['esta semana', 'week'],
      ['del mes', 'month'],
      ['hoy', 'day'],
      [undefined, 'day'],
    ])('reads %s as %s', (spoken, expected) => {
      expect(parsePeriod(spoken)).toBe(expected);
    });

    /**
     * Antes de que existiera `yesterday`, "ayer" caía en `day` y la skill
     * respondía con las ventas de hoy sin decir que no era lo preguntado.
     */
    it('no longer answers yesterday with today', () => {
      expect(parsePeriod('ayer')).not.toBe('day');
    });

    it('does not read anteayer as yesterday', () => {
      // Responder anteayer con las cifras de ayer es equivocarse en silencio.
      expect(parsePeriod('anteayer')).toBe('day');
    });
  });

  describe('periodRange', () => {
    // Un martes a las 3 de la tarde.
    const now = new Date(2026, 8, 15, 15, 0, 0);

    it('closes yesterday at midnight instead of running to now', () => {
      const { from, to } = periodRange('yesterday', now);
      expect(from).toEqual(new Date(2026, 8, 14, 0, 0, 0, 0));
      // Y no `now`: comparar un día entero contra lo que va de hoy haría que
      // ayer siempre pareciera mejor.
      expect(to).toEqual(new Date(2026, 8, 15, 0, 0, 0, 0));
    });

    it('keeps today open until now', () => {
      const { from, to } = periodRange('day', now);
      expect(from).toEqual(new Date(2026, 8, 15, 0, 0, 0, 0));
      expect(to).toBe(now);
    });

    it('starts the week on monday and the month on the first', () => {
      expect(periodRange('week', now).from).toEqual(
        new Date(2026, 8, 14, 0, 0, 0, 0),
      );
      expect(periodRange('month', now).from).toEqual(
        new Date(2026, 8, 1, 0, 0, 0, 0),
      );
    });

    it('crosses the month boundary backwards', () => {
      const firstOfMonth = new Date(2026, 8, 1, 9, 0, 0);
      expect(periodRange('yesterday', firstOfMonth).from).toEqual(
        new Date(2026, 7, 31, 0, 0, 0, 0),
      );
    });
  });

  it('says ayer out loud, not "el día de ayer"', () => {
    expect(periodLabel('yesterday')).toBe('ayer');
  });

  /**
   * El slot REPORT_PERIOD de Alexa, espejado.
   *
   * Alexa entrega el valor CANÓNICO del slot, no lo que la persona dijo: quien
   * dice "de hoy" llega aquí como "día". Si un valor del modelo deja de
   * resolver, la skill responde con el período por defecto sin avisar —una
   * cifra correcta de la ventana equivocada—, y eso es indetectable en
   * producción.
   *
   * Debe seguir a `docs/alexa/interaction-model.es.json` en el repo del
   * frontend. Un valor nuevo allá entra también aquí.
   */
  describe('valores del slot REPORT_PERIOD', () => {
    const SLOT_VALUES: [string, ReportPeriod][] = [
      ['día', 'day'],
      ['ayer', 'yesterday'],
      ['semana', 'week'],
      ['semana pasada', 'lastWeek'],
      ['mes', 'month'],
      ['mes pasado', 'lastMonth'],
      ['año', 'year'],
      ['últimos 7 días', 'last:7'],
      ['últimos 15 días', 'last:15'],
      ['últimos 30 días', 'last:30'],
      ['últimos 90 días', 'last:90'],
    ];

    for (const [spoken, expected] of SLOT_VALUES) {
      it(`"${spoken}" → ${expected}`, () => {
        expect(parsePeriodText(spoken)).toBe(expected);
      });
    }

    it('resuelve los meses por su nombre', () => {
      // El año no se fija en el test: `monthPeriod` elige el más reciente ya
      // vivido, así que en enero "diciembre" es el del año anterior.
      expect(parsePeriodText('marzo')).toMatch(/^month:\d{4}-03$/);
      expect(parsePeriodText('en septiembre')).toMatch(/^month:\d{4}-09$/);
      expect(parsePeriodText('setiembre')).toMatch(/^month:\d{4}-09$/);
    });

    it('no confunde "los últimos 15 días" con "el día"', () => {
      expect(parsePeriodText('los últimos 15 días')).toBe('last:15');
    });

    it('nombra en voz alta el rango que usó', () => {
      expect(periodLabel('last:15')).toBe('en los últimos 15 días');
      expect(periodLabel('lastMonth')).toBe('el mes pasado');
      expect(periodLabel('month:2026-03')).toContain('marzo');
    });
  });

  describe('rangos de los períodos nuevos', () => {
    // Un martes a las 3 de la tarde.
    const now = new Date(2026, 8, 22, 15, 0, 0);

    it('cuenta los últimos N días incluyendo hoy', () => {
      const { from, to } = periodRange('last:7', now);
      expect(from.getDate()).toBe(16);
      expect(from.getHours()).toBe(0);
      expect(to).toEqual(now);
    });

    it('cierra el mes pasado de punta a punta', () => {
      const { from, to } = periodRange('lastMonth', now);
      expect(from).toEqual(new Date(2026, 7, 1));
      expect(to).toEqual(new Date(2026, 8, 1));
    });

    it('corta el mes en curso AHORA, no al final del mes', () => {
      const { from, to } = periodRange('month:2026-09', now);
      expect(from).toEqual(new Date(2026, 8, 1));
      expect(to).toEqual(now);
    });

    it('deja cerrado un mes ya pasado', () => {
      const { from, to } = periodRange('month:2026-03', now);
      expect(from).toEqual(new Date(2026, 2, 1));
      expect(to).toEqual(new Date(2026, 3, 1));
    });
  });
});
