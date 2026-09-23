import { CO_TZ, clockTimeCO } from '../../common/date.util';

/**
 * Horario de atención del equipo: lunes a sábado, 8:00 a.m. a 7:00 p.m.
 *
 * Esto NO limita al asistente. Un dueño que pregunta sus ventas un domingo a
 * las nueve de la noche debe obtener su cifra: para eso existe el asistente, y
 * callarse sería quitarle justo el valor que tiene. Lo que sí respeta el
 * horario es el **escalamiento a una persona**, porque ahí sí hay alguien de
 * carne y hueso que tiene que contestar.
 *
 * Todo en hora Colombia. El proceso corre con `TZ=America/Bogota`, pero el día
 * de la semana se calcula con el timezone explícito para que un despliegue en
 * otra región no mueva el horario en silencio.
 */

const OPEN_HOUR = Number(process.env.SUPPORT_OPEN_HOUR ?? 8);
const CLOSE_HOUR = Number(process.env.SUPPORT_CLOSE_HOUR ?? 19);
/** 0 = domingo. Lunes a sábado. */
const OPEN_DAYS = [1, 2, 3, 4, 5, 6];

const DAY_NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

/** Día de la semana colombiano (0 = domingo) de un instante. */
function weekdayCO(at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: CO_TZ,
    weekday: 'short',
  }).format(at);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/** Hora del reloj colombiano, con minutos como fracción. */
function hourCO(at: Date): number {
  const [h, m] = clockTimeCO(at).split(':').map(Number);
  return h + m / 60;
}

export function isBusinessHours(at: Date = new Date()): boolean {
  const day = weekdayCO(at);
  if (!OPEN_DAYS.includes(day)) return false;
  const hour = hourCO(at);
  return hour >= OPEN_HOUR && hour < CLOSE_HOUR;
}

const openAtText = (): string =>
  `las ${OPEN_HOUR}:00 ${OPEN_HOUR < 12 ? 'a.m.' : 'p.m.'}`;

/**
 * Cuándo vuelve a haber alguien, dicho como se dice.
 *
 * "mañana a las 8:00 a.m." es más útil que "el martes": quien escribe un lunes
 * por la noche no necesita el nombre del día, necesita saber que es pronto.
 */
export function nextOpeningText(at: Date = new Date()): string {
  if (isBusinessHours(at)) return 'en un momento';

  const today = weekdayCO(at);
  const hour = hourCO(at);
  // Todavía es día hábil y aún no abren: es hoy mismo.
  if (OPEN_DAYS.includes(today) && hour < OPEN_HOUR) {
    return `hoy a partir de ${openAtText()}`;
  }

  // Se busca el próximo día hábil, empezando por mañana.
  for (let ahead = 1; ahead <= 7; ahead++) {
    const day = (today + ahead) % 7;
    if (!OPEN_DAYS.includes(day)) continue;
    const when = ahead === 1 ? 'mañana' : `el ${DAY_NAMES[day]}`;
    return `${when} a partir de ${openAtText()}`;
  }
  return `a partir de ${openAtText()}`;
}

/** La frase completa del escalamiento, con el horario si toca esperar. */
export function handoffTiming(at: Date = new Date()): string {
  return isBusinessHours(at)
    ? 'Un asesor te escribe por aquí en un momento.'
    : `Nuestro horario de atención es de lunes a sábado, de ${OPEN_HOUR}:00 a.m. a ${CLOSE_HOUR - 12}:00 p.m., así que un asesor te escribe ${nextOpeningText(at)}.`;
}
