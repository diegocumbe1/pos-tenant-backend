import { normalizeCommand } from './proposal-commands';

export interface ParsedAmount {
  /** Lo que se entendió. Si es `ambiguous`, también podría ser en miles. */
  amountCOP: number;
  ambiguous: boolean;
}

export interface ParsedExpense {
  amount: ParsedAmount | null;
  concept: string | null;
  /** Cómo nombró de dónde salió la plata. Se resuelve contra las cuentas reales. */
  accountHint: string | null;
  /** Días hacia atrás: 0 = hoy, 1 = ayer, 2 = antes de ayer. */
  daysAgo: number;
}

const MAX_AMOUNT = 2_000_000_000;
export const MAX_CONCEPT = 160;

const AMOUNT =
  /\$?\s*(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)(?:\s*(millones|millón|millon|palos?|mil|lucas?|k)(?![\p{L}\d])(?:\s+(\d{3})\b)?)?/giu;

interface AmountHit extends ParsedAmount {
  index: number;
  length: number;
  /** Tiene unidad, separador de miles o es grande: no se confunde con una cantidad. */
  strong: boolean;
}

function readAmount(match: RegExpMatchArray): AmountHit | null {
  const [whole, digits, unit, rest] = match;
  const thousands = /^\d{1,3}(?:[.,]\d{3})+$/.test(digits);
  const base = thousands
    ? Number(digits.replace(/[.,]/g, ''))
    : Number(digits.replace(',', '.'));
  const lower = unit?.toLowerCase();
  let amount: number;
  if (!lower) {
    // "1,5" sin unidad no es un valor en pesos.
    if (!thousands && !Number.isInteger(base)) return null;
    amount = base;
  } else if (/^(mill|palo)/.test(lower)) {
    amount = base * 1_000_000;
  } else {
    amount = base * 1_000;
  }
  // "2 mil 500". Solo después de mil: tras un millón sería otra cosa.
  if (rest && lower && !/^(mill|palo)/.test(lower)) amount += Number(rest);
  amount = Math.round(amount);
  if (amount < 1 || amount > MAX_AMOUNT) return null;
  return {
    amountCOP: amount,
    ambiguous: !lower && !thousands && amount < 1000,
    index: match.index ?? 0,
    length: whole.length,
    strong: !!lower || thousands || amount >= 1000,
  };
}

/** El monto que se dijo. El primero inequívoco: en "3 recibos por 50 mil" son los 50 mil. */
function findAmount(text: string): AmountHit | null {
  const hits = [...text.matchAll(AMOUNT)]
    .map(readAmount)
    .filter((hit): hit is AmountHit => !!hit);
  return hits.find((hit) => hit.strong) ?? hits[0] ?? null;
}

export function parseAmount(text: string): ParsedAmount | null {
  const hit = findAmount(text);
  return hit ? { amountCOP: hit.amountCOP, ambiguous: hit.ambiguous } : null;
}

const START =
  /^(?:(?:registra(?:r)?|anota(?:r)?|apunta(?:r)?)\s+(?:(?:un|el)\s+)?gasto(?:\s+de)?|gaste|gasto\s+de|pague)\b/;

/** ¿Está registrando un gasto, o preguntando por ellos? */
export function isExpenseCaptureStart(message: string): boolean {
  if (message.includes('?')) return false;
  const text = normalizeCommand(message);
  if (!START.test(text)) return false;
  // "gasto de ayer" es una consulta; "gasto de 50 mil" es un registro.
  if (text.startsWith('gasto de') && !/\d/.test(text)) return false;
  // "gasté mucho este mes" y "pagué de más" son comentarios, no un registro.
  return !/\b(?:cuanto|mucho|demasiado|de mas)\b/.test(text);
}

const LEADING =
  /^\s*(?:(?:registr[ae]r?|anot[ae]r?|apunt[ae]r?)\s+(?:(?:un|el)\s+)?gasto(?:\s+de)?|gast[eé]|gasto\s+de|pagu[eé])(?=\s|$)/i;
const ACCOUNT_WORDS =
  'efectivo|nequi|daviplata|bancolombia|davivienda|transferencia|tarjeta|bre-?b|llave|banco|caja menor|caja';
const TRAILING_ACCOUNT = new RegExp(
  `(?:^|\\s)(?:por|con|en|desde|de|del|de la)\\s+(?:la\\s+|el\\s+)?(${ACCOUNT_WORDS})\\s*$`,
  'i',
);
const WHEN = /(?:^|\s)(antes de ayer|anteayer|ayer|hoy)(?=\s|$)/i;
const CONNECTORS = /^(?:en|de|del|por|para|a)\s+/i;
const TRAILING_CONNECTOR = /\s+(?:en|de|del|por|para|a|y)$/i;

/** Entiende lo que se pueda de la frase. Lo que falte, Lynko lo pregunta. */
export function parseExpenseMessage(message: string): ParsedExpense {
  let text = message.replace(/\s+/g, ' ').trim().replace(LEADING, '').trim();

  const hit = findAmount(text);
  if (hit) {
    text = `${text.slice(0, hit.index)} ${text.slice(hit.index + hit.length)}`;
  }

  let daysAgo = 0;
  const when = WHEN.exec(text);
  if (when) {
    const word = normalizeCommand(when[1]);
    daysAgo = word === 'hoy' ? 0 : word === 'ayer' ? 1 : 2;
    text = text.replace(WHEN, ' ');
  }
  text = text.replace(/\s+/g, ' ').trim();

  let accountHint: string | null = null;
  const account = TRAILING_ACCOUNT.exec(text);
  if (account) {
    accountHint = normalizeCommand(account[1]);
    text = text.slice(0, account.index).trim();
  }

  text = text
    .replace(/^pesos\b/i, '')
    .trim()
    .replace(CONNECTORS, '')
    .replace(TRAILING_CONNECTOR, '')
    .trim();

  return {
    amount: hit ? { amountCOP: hit.amountCOP, ambiguous: hit.ambiguous } : null,
    concept: cleanConcept(text),
    accountHint,
    daysAgo,
  };
}

export function cleanConcept(text: string): string | null {
  const clean = text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || !/\p{L}/u.test(clean)) return null;
  return (clean[0].toUpperCase() + clean.slice(1)).slice(0, MAX_CONCEPT);
}

/**
 * Las categorías que se ofrecen. Los nombres son los de la pantalla de Finanzas
 * (`shared/finance/cash-categories.ts`).
 *
 * No están nómina, sueldo del dueño, compra de inventario, comisión ni faltante
 * porque esos gastos los escriben sus propios flujos: registrarlos aquí los
 * contaría dos veces.
 */
export const EXPENSE_CATEGORY_OPTIONS = [
  { value: 'OPERATIONS', label: 'Operaciones' },
  { value: 'UTILITIES', label: 'Servicios' },
  { value: 'RENT', label: 'Arriendo' },
  { value: 'MAINTENANCE', label: 'Mantenimiento' },
  { value: 'KITCHEN', label: 'Cocina / Insumos' },
  { value: 'INVENTORY_SHIPPING', label: 'Envío / flete' },
  { value: 'SALES_SHIPPING', label: 'Envío a cliente' },
  { value: 'PETTY_CASH', label: 'Caja menor' },
  { value: 'TAXES', label: 'Impuestos' },
  { value: 'PLATFORM', label: 'Plataforma / Software' },
  { value: 'EXTRAORDINARY', label: 'Extraordinarios' },
  { value: 'OTHER', label: 'Otros' },
] as const;

/** A qué cuenta se refiere "efectivo", "nequi"… Nunca adivina entre varias. */
export function matchAccount<
  T extends { name: string; type: string; defaultForMethods: string[] },
>(hint: string, accounts: T[]): T | null {
  const byMethod: Record<string, string> = {
    efectivo: 'CASH',
    transferencia: 'TRANSFER',
    tarjeta: 'CARD',
  };
  const method = byMethod[hint];
  const named = accounts.filter((account) =>
    normalizeCommand(account.name).includes(hint),
  );
  const candidates = named.length
    ? named
    : method
      ? accounts.filter(
          (account) =>
            account.defaultForMethods.includes(method) ||
            (method === 'CASH' && account.type === 'CASH'),
        )
      : [];
  return candidates.length === 1 ? candidates[0] : null;
}
