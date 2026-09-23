import {
  handoffTiming,
  isBusinessHours,
  nextOpeningText,
} from './business-hours';

/**
 * Las fechas van con offset -05:00 explícito: sin él, una cadena sin zona se
 * interpreta con la del proceso y la prueba diría cosas distintas según dónde
 * corra. El horario es colombiano, así que se escribe colombiano.
 */
const at = (iso: string) => new Date(`${iso}-05:00`);

describe('horario de atención', () => {
  // 2026-09-21 es lunes; 2026-09-26, sábado; 2026-09-27, domingo.
  it('abre de lunes a sábado entre 8:00 y 19:00', () => {
    expect(isBusinessHours(at('2026-09-21T08:00:00'))).toBe(true);
    expect(isBusinessHours(at('2026-09-21T18:59:00'))).toBe(true);
    expect(isBusinessHours(at('2026-09-26T12:00:00'))).toBe(true);
  });

  it('está cerrado antes de abrir, después de cerrar y los domingos', () => {
    expect(isBusinessHours(at('2026-09-21T07:59:00'))).toBe(false);
    // Las 19:00 en punto ya es cierre: el rango es [8, 19).
    expect(isBusinessHours(at('2026-09-21T19:00:00'))).toBe(false);
    expect(isBusinessHours(at('2026-09-27T12:00:00'))).toBe(false);
  });

  it('de madrugada un día hábil, el próximo turno es hoy mismo', () => {
    expect(nextOpeningText(at('2026-09-22T03:00:00'))).toContain('hoy');
  });

  it('un lunes en la noche, mañana', () => {
    expect(nextOpeningText(at('2026-09-21T22:00:00'))).toContain('mañana');
  });

  it('un sábado en la noche salta el domingo y cae en lunes', () => {
    const text = nextOpeningText(at('2026-09-26T21:00:00'));
    expect(text).toContain('lunes');
    expect(text).not.toContain('domingo');
  });

  it('un domingo, mañana es lunes', () => {
    expect(nextOpeningText(at('2026-09-27T10:00:00'))).toContain('mañana');
  });

  it('dentro del horario no promete horarios, promete pronto', () => {
    const text = handoffTiming(at('2026-09-21T10:00:00'));
    expect(text).toContain('en un momento');
    expect(text).not.toContain('horario de atención');
  });

  it('fuera del horario dice cuándo, en vez de prometer que ya', () => {
    const text = handoffTiming(at('2026-09-27T23:30:00'));
    expect(text).toContain('horario de atención');
    expect(text).toContain('mañana');
  });
});
