import { parsePeriod, periodLabel, periodRange } from './report-period';

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
});
