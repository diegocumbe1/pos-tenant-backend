import { addCalendarDaysCO } from '../../common/date.util';
import { parseAmount } from './expense-capture';
import { normalizeCommand } from './proposal-commands';

export type SaleMethod = 'CASH' | 'CARD' | 'TRANSFER' | 'OTHER';

export const METHOD_LABELS: Record<SaleMethod, string> = {
  CASH: 'Efectivo',
  TRANSFER: 'Transferencia',
  CARD: 'Tarjeta',
  OTHER: 'Otro',
};

/** Día calendario, o `SIN_FECHA` si el cliente no sabe. */
export type DueDate = string;
export const SIN_FECHA = 'none';

export interface ParsedSaleLine {
  /** Lo que se dijo del producto, sin la cantidad. */
  text: string;
  quantity?: number;
}

/** Lo que se entendió de la frase. Lo que no esté aquí, Lynko lo pregunta. */
export interface ParsedSale {
  lines: ParsedSaleLine[];
  /** true = pagó completo. false = queda saldo. undefined = no se dijo. */
  paid?: boolean;
  /** true = se lo llevó. false = se entrega luego. undefined = no se dijo. */
  delivered?: boolean;
  depositCOP?: number;
  method?: SaleMethod;
  /** Financiación o pago repartido: esas no se registran por chat. */
  needsMostrador?: 'financing' | 'split';
  customer?: string;
  /** Día de pago; 'none' = dijeron que no se sabe. */
  dueOn?: DueDate;
  daysAgo: number;
  wholesale: boolean;
  deliveryNote?: string;
  price?: { amountCOP: number; per: 'unit' | 'total' };
}

const AMOUNT_TEXT =
  '\\$?\\s*\\d[\\d.,]*(?:\\s*(?:millones|millon|palos?|mil|lucas?|k)(?![a-z0-9]))?(?:\\s+\\d{3}(?![0-9]))?';

const SALE_START =
  /^(?:(?:registra(?:r)?|anota(?:r)?|apunta(?:r)?)\s+(?:(?:una|la)\s+)?venta|vendi(?:mos)?|venta\s+de\s+\d|separa(?:r|le|me)?|separado\s+de|encargo\s+(?:de|para))(?:\s|$)/;

/** ¿Está registrando una venta, o preguntando por ellas? */
export function isSaleCaptureStart(message: string): boolean {
  if (message.includes('?')) return false;
  const text = normalizeCommand(message);
  if (!SALE_START.test(text)) return false;
  return !/\b(?:cuanto|cuantos|cuantas|mucho|poco|bien|mal)\b/.test(text);
}

const stripAccents = (text: string) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Las dos versiones avanzan juntas: se busca sin tildes y se conserva lo escrito. */
class Sentence {
  plain: string;
  original: string;
  /** Cómo estaba el original antes del último `take`. */
  private before: string;

  constructor(message: string) {
    const clean = message.normalize('NFC').replace(/\s+/g, ' ').trim();
    const plain = stripAccents(clean);
    // Si quitar tildes movió las posiciones, se trabaja solo con lo normalizado.
    this.original = plain.length === clean.length ? clean : plain;
    this.plain = plain;
    this.before = this.original;
  }

  /** Quita lo que coincida y lo devuelve. */
  take(pattern: RegExp): RegExpExecArray | null {
    const match = pattern.exec(this.plain);
    if (!match) return null;
    this.before = this.original;
    const blank = ' '.repeat(match[0].length);
    const cut = (text: string) =>
      text.slice(0, match.index) +
      blank +
      text.slice(match.index + match[0].length);
    this.plain = cut(this.plain);
    this.original = cut(this.original);
    return match;
  }

  /** El texto original del grupo 1 de una coincidencia, antes de quitarla. */
  originalOf(match: RegExpExecArray, group: number): string {
    const start = match.index + match[0].indexOf(match[group]);
    return this.before.slice(start, start + match[group].length);
  }
}

const METHOD_WORDS: Record<string, SaleMethod> = {
  efectivo: 'CASH',
  tarjeta: 'CARD',
  datafono: 'CARD',
  nequi: 'TRANSFER',
  daviplata: 'TRANSFER',
  bancolombia: 'TRANSFER',
  davivienda: 'TRANSFER',
  transferencia: 'TRANSFER',
  llave: 'TRANSFER',
  breb: 'TRANSFER',
  'bre-b': 'TRANSFER',
  qr: 'TRANSFER',
};
const METHOD_ALTERNATIVES = Object.keys(METHOD_WORDS).join('|');
const METHOD = new RegExp(
  `(?:^|[\\s,])(?:por|en|con|de)\\s+(${METHOD_ALTERNATIVES})\\b`,
);

const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};

/** Cómo se lee el método de una palabra suelta ("nequi", "por efectivo"). */
export function parseMethod(text: string): SaleMethod | null {
  const clean = normalizeCommand(text).replace(/^(?:por|en|con|de)\s+/, '');
  return METHOD_WORDS[clean] ?? null;
}

export const NO_DATE =
  /^(?:no sabe|no se sabe|sin fecha|no se|ninguna|no dijo|despues miramos|no tiene fecha)$/;

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};
const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

const dayKey = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const validDay = (year: number, month: number, day: number) =>
  day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Del texto al día calendario. Si no es una fecha clara, null: se vuelve a preguntar. */
export function parseDueDate(text: string, today: string): DueDate | null {
  const said = normalizeCommand(text).replace(
    /^(?:el|la|para el|para la|en)\s+/,
    '',
  );
  if (NO_DATE.test(said)) return 'none';

  const [year, month, dayOfMonth] = today.split('-').map(Number);
  if (said === 'hoy') return today;
  if (said === 'manana') return addCalendarDaysCO(today, 1);
  if (said === 'pasado manana') return addCalendarDaysCO(today, 2);

  const weekday = WEEKDAYS[said.replace(/^(?:proximo|este)\s+/, '')];
  if (weekday !== undefined) {
    const current = new Date(`${today}T12:00:00Z`).getUTCDay();
    const ahead = (weekday - current + 7) % 7 || 7;
    return addCalendarDaysCO(today, ahead);
  }

  if (/^(?:fin de mes|final de mes|fin del mes)$/.test(said)) {
    return dayKey(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate());
  }
  if (/^(?:otra quincena|quincena|proxima quincena)$/.test(said)) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (dayOfMonth < 15) return dayKey(year, month, 15);
    if (dayOfMonth < lastDay) return dayKey(year, month, lastDay);
    return month === 12 ? dayKey(year + 1, 1, 15) : dayKey(year, month + 1, 15);
  }

  const named = /^(\d{1,2})\s+de\s+([a-z]+)$/.exec(said);
  if (named) {
    const namedMonth = MONTHS.indexOf(named[2]) + 1;
    const namedDay = Number(named[1]);
    if (!namedMonth) return null;
    const namedYear =
      dayKey(year, namedMonth, namedDay) < today ? year + 1 : year;
    return validDay(namedYear, namedMonth, namedDay)
      ? dayKey(namedYear, namedMonth, namedDay)
      : null;
  }

  const bare = /^(\d{1,2})$/.exec(said);
  if (bare) {
    const bareDay = Number(bare[1]);
    if (bareDay >= dayOfMonth && validDay(year, month, bareDay)) {
      return dayKey(year, month, bareDay);
    }
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    return validDay(nextYear, nextMonth, bareDay)
      ? dayKey(nextYear, nextMonth, bareDay)
      : null;
  }
  return null;
}

export function parseSaleMessage(message: string, today: string): ParsedSale {
  const sentence = new Sentence(message);
  const parsed: ParsedSale = { lines: [], daysAgo: 0, wholesale: false };

  // El verbo también dice algo: "sepárale" es no pagó y no se lo llevó.
  const verb = sentence.take(
    /^(?:(?:registra(?:r)?|anota(?:r)?|apunta(?:r)?)\s+(?:(?:una|la)\s+)?venta(?:\s+de)?|vendi(?:mos)?|venta\s+de|separa(?:r|le|me)?|separado\s+de|encargo\s+de|encargo(?=\s+para))(?=\s|$)/,
  );
  if (verb && /^separ/.test(verb[0])) {
    parsed.paid = false;
    parsed.delivered = false;
  } else if (verb && /^encargo/.test(verb[0])) {
    parsed.delivered = false;
  }

  if (sentence.take(/(?:^|[\s,])(?:mitad|parte)\s+(?:en|por|con)\b.*$/)) {
    parsed.needsMostrador = 'split';
  }
  if (sentence.take(/\b(?:financiad[oa]|financiacion|addi|sistecredito)\b/)) {
    parsed.needsMostrador = 'financing';
  }

  const due = sentence.take(
    /(?:^|[\s,])(?:(?:me\s+)?paga(?:ra|n)?|va\s+a\s+pagar)\s+(el\s+|la\s+|para\s+el\s+)?([a-z0-9 ]+?)\s*(?=,|$|\s+y\s)/,
  );
  if (due) {
    const day = parseDueDate(due[2], today);
    if (day) parsed.dueOn = day;
    parsed.paid = false;
  }

  const deposit = sentence.take(
    new RegExp(`\\b(?:dejo|abono(?:\\s+de)?|dio|adelanto)\\s+(${AMOUNT_TEXT})`),
  );
  if (deposit) {
    const amount = parseAmount(deposit[1]);
    if (amount && !amount.ambiguous) parsed.depositCOP = amount.amountCOP;
    parsed.paid = false;
  }

  if (
    sentence.take(
      /\b(?:quedo?a?n?\s+debiendo|me\s+debe|debe\s+todo|fiad[oa]|a\s+credito|sin\s+pagar|no\s+(?:ha\s+)?pago|pendiente\s+de\s+pago)\b/,
    )
  ) {
    parsed.paid = false;
  }

  const later = sentence.take(
    /(?:^|[\s,])((?:se\s+(?:lo|la|los|las|le)\s+)?(?:entrega|entregamos|entrego|envia|enviamos|mando|manda|lleva|llevo)\s+(?:luego|despues|manana|mas\s+tarde|otro\s+dia|la\s+otra\s+semana|el\s+[a-z0-9]+)|se\s+entrega\s+(?:luego|despues|manana)|por\s+entregar|entrega\s+pendiente|pendiente\s+de\s+entrega|para\s+entregar)\b/,
  );
  if (later) {
    parsed.delivered = false;
    parsed.deliveryNote = sentence.originalOf(later, 1).trim();
  } else if (
    sentence.take(
      /\b(?:(?:ya\s+)?se\s+(?:lo|la|los|las)\s+llevo|ya\s+(?:se\s+)?entreg[oe]|entregad[oa]s?)\b/,
    )
  ) {
    parsed.delivered = true;
  }

  const method = sentence.take(METHOD);
  if (method) {
    parsed.method = METHOD_WORDS[method[1]];
    if (sentence.take(METHOD)) parsed.needsMostrador = 'split';
  }

  if (
    sentence.take(
      /\b(?:ya\s+pago|pago\s+(?:completo|todo)|pagad[oa]|ya\s+cancelo|cobrad[oa]|de\s+contado)\b/,
    )
  ) {
    parsed.paid = true;
  }
  // "por nequi" sin más es que pagó; con deuda declarada, el medio es del abono.
  if (parsed.method && parsed.paid === undefined) parsed.paid = true;

  if (sentence.take(/\b(?:al\s+por\s+mayor|por\s+mayor|mayorista)\b/)) {
    parsed.wholesale = true;
  }

  const when = sentence.take(
    /(?:^|[\s,])(antes\s+de\s+ayer|anteayer|ayer|hoy)(?=[\s,]|$)/,
  );
  if (when) {
    parsed.daysAgo = when[1] === 'hoy' ? 0 : when[1] === 'ayer' ? 1 : 2;
  }

  const price = sentence.take(
    new RegExp(
      `(?:^|[\\s,])(a|por|en)\\s+(${AMOUNT_TEXT})(\\s+(?:cada\\s+\\w+|c/u))?(?=[\\s,]|$)`,
    ),
  );
  if (price) {
    const amount = parseAmount(price[2]);
    if (amount && !amount.ambiguous) {
      parsed.price = {
        amountCOP: amount.amountCOP,
        per: price[1] === 'a' || price[3] ? 'unit' : 'total',
      };
    }
  }

  // El cliente: el último "a Fulano". "para" solo cuenta si hay encargo, porque
  // "crema para manos" es un producto.
  const customerRe =
    /(?:^|[\s,])a\s+((?!base\b)[a-z]+(?:\s+[a-z]+){0,3}?)(?=\s*(?:,|$|\d|\bun\b|\buna\b))/g;
  let customer: RegExpExecArray | null = null;
  for (const hit of sentence.plain.matchAll(customerRe)) customer = hit;
  if (!customer && parsed.delivered === false) {
    customer =
      /(?:^|[\s,])para\s+([a-z]+(?:\s+[a-z]+){0,3}?)(?=\s*(?:,|$|\d))/.exec(
        sentence.plain,
      );
  }
  if (customer) {
    parsed.customer = titleCase(sentence.originalOf(customer, 1));
    const exact = new RegExp(
      customer[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
    sentence.take(exact);
  }

  parsed.lines = sentence.original
    .replace(/\s+/g, ' ')
    .split(/,|\s+y\s+(?=\d|un\b|una\b|dos\b|tres\b|cuatro\b|cinco\b)/i)
    .flatMap((segment) => {
      const line = parseSaleLine(segment);
      return line ? [line] : [];
    });

  return parsed;
}

/** "2 mantequillas de coco" → cantidad y texto. */
export function parseSaleLine(segment: string): ParsedSaleLine | null {
  let text = segment
    .trim()
    .replace(/^(?:y|de|del|la|el|los|las)\s+/i, '')
    .replace(/\s+(?:y|de|del|por|en|con|a)$/i, '')
    .trim();
  if (!/\p{L}/u.test(text) || /^(?:y|de|del|la|el|los|las)$/i.test(text)) {
    return null;
  }

  const digits = /^(\d{1,4})\s+(.+)$/.exec(text);
  const word = /^(\p{L}+)\s+(.+)$/u.exec(text);
  let quantity: number | undefined;
  if (digits) {
    quantity = Number(digits[1]);
    text = digits[2];
  } else if (word && NUMBER_WORDS[stripAccents(word[1])]) {
    quantity = NUMBER_WORDS[stripAccents(word[1])];
    text = word[2];
  }
  return quantity ? { text, quantity } : { text };
}

function titleCase(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

// ─── Productos ───────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'con',
  'y',
  'un',
  'una',
]);

/** "mantequillas" y "mantequilla" son lo mismo; el resto se compara tal cual. */
function stem(token: string): string {
  const singular =
    token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token;
  // "perfumes"/"perfume" y "pantalones"/"pantalon" terminan en lo mismo.
  return singular.length > 3 && singular.endsWith('e')
    ? singular.slice(0, -1)
    : singular;
}

export function tokensOf(text: string): string[] {
  return normalizeCommand(text)
    .split(/[\s\-/·]+/)
    .filter((token) => token && !STOP_WORDS.has(token))
    .map(stem);
}

export interface ProductMatch<T> {
  product: T;
  /** Lo que se dijo y no está en el nombre: puede ser la opción ("coco"). */
  leftover: string[];
}

/**
 * Los productos que mejor coinciden con lo que se dijo. Nunca devuelve "el más
 * parecido" para decidir solo: si hay empate, vuelven todos y se pregunta.
 */
export function matchProducts<
  T extends { name: string; variants?: { label: string }[] },
>(said: string, products: T[]): ProductMatch<T>[] {
  const tokens = tokensOf(said);
  if (!tokens.length) return [];

  const scored = products.flatMap((product) => {
    const name = new Set(tokensOf(product.name));
    const hits = tokens.filter((token) => name.has(token));
    if (!hits.length) return [];
    const leftover = tokens.filter((token) => !name.has(token));
    // Si lo que sobró es una opción de ese producto, ese es el producto.
    const optionFits =
      leftover.length > 0 &&
      (product.variants ?? []).some((variant) =>
        variantFits(variant.label, leftover),
      );
    const exact = hits.length === name.size && !leftover.length;
    return [
      {
        product,
        leftover,
        score: hits.length * 2 + (optionFits ? 1 : 0) + (exact ? 10 : 0),
      },
    ];
  });
  const best = Math.max(0, ...scored.map((row) => row.score));
  return scored
    .filter((row) => row.score === best)
    .map(({ product, leftover }) => ({ product, leftover }));
}

export function variantFits(label: string, wanted: string[]): boolean {
  const tokens = new Set(tokensOf(label));
  return wanted.every((token) => tokens.has(token));
}
