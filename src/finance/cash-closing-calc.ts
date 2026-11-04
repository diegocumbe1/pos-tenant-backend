import { calendarDayCO } from '../common/date.util';
import type { CashMovement } from './finance.service';

/**
 * El cálculo del cierre de caja, sin base de datos.
 * Docs: docs/PLAN_CAJA_REAL_CIERRES_Y_CUENTAS.md
 *
 * LA DIFERENCIA SE RECALCULA, NO SE GUARDA. Cada cierre parte de lo último que
 * alguien contó, más lo que se movió desde entonces. Así, anotar hoy un gasto
 * olvidado con fecha de ayer reduce el descuadre de ayer sin ningún paso extra,
 * y un faltante de ayer no se repite hoy.
 */

/** Por debajo de esto, una cuenta "cuadra": nadie cuenta monedas de $50. */
export const CASH_TOLERANCE_COP = 1000;

export const CASH_DIFFERENCE_CATEGORY = 'CASH_DIFFERENCE';
export const CASH_SHORTAGE_CATEGORY = 'CASH_SHORTAGE';

export interface ClosingAccount {
  id: string;
  name: string;
  type: string;
  defaultForMethods: string[];
}

export interface ClosingInput {
  id: string;
  day: string;
  expectedTotalCOP: number;
  lines: Array<{
    accountId: string;
    countedCOP: number;
    expectedSnapshotCOP: number | null;
  }>;
}

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amountCOP: number;
  occurredAt: Date;
}

export interface ChainLine {
  accountId: string;
  countedCOP: number;
  /** null en el primer cierre: el histórico no dice de qué cuenta salió cada gasto. */
  expectedCOP: number | null;
  differenceCOP: number | null;
  expectedSnapshotCOP: number | null;
}

export interface ChainEntry {
  id: string;
  day: string;
  previousDay: string | null;
  isFirst: boolean;
  countedTotalCOP: number;
  /** Lo esperado HOY, con los movimientos actuales. */
  expectedTotalCOP: number;
  differenceCOP: number;
  /** Lo esperado cuando se cerró: la foto de auditoría. */
  expectedAtCloseCOP: number;
  differenceAtCloseCOP: number;
  /** Cobrado por ventas en lo que abarca este cierre: la base del % de pérdida. */
  collectedCOP: number;
  /** Lo que se movió sin decir de qué cuenta: entra al total, no a una cuenta. */
  unassignedNetCOP: number;
  lines: ChainLine[];
  rows: CashMovement[];
}

const net = (row: CashMovement) =>
  row.direction === 'IN' ? row.amountCOP : -row.amountCOP;

/** Un cobro sin cuenta explícita cae en la cuenta por defecto de su medio. */
export function rowAccount(
  row: CashMovement,
  accounts: ClosingAccount[],
): string | null {
  if (row.moneyAccountId) return row.moneyAccountId;
  if (row.origin !== 'SALES' || row.direction !== 'IN' || !row.method) {
    return null;
  }
  const method = row.method.toUpperCase();
  return accounts.find((a) => a.defaultForMethods.includes(method))?.id ?? null;
}

/** Cuánto se movió cada cuenta en unas filas, y cuánto quedó sin cuenta. */
function netByAccount(
  rows: CashMovement[],
  transfers: TransferInput[],
  accounts: ClosingAccount[],
) {
  const byAccount = new Map<string, number>();
  const add = (id: string, amount: number) =>
    byAccount.set(id, (byAccount.get(id) ?? 0) + amount);
  let unassignedNetCOP = 0;
  for (const row of rows) {
    // Lo pagado por fuera no tocó ninguna cuenta del negocio.
    if (row.outsideBusiness) continue;
    const account = rowAccount(row, accounts);
    if (account) add(account, net(row));
    else unassignedNetCOP += net(row);
  }
  for (const t of transfers) {
    add(t.fromAccountId, -t.amountCOP);
    add(t.toAccountId, t.amountCOP);
  }
  return { byAccount, unassignedNetCOP };
}

function inWindow(at: Date, after: string | null, upTo: string) {
  const day = calendarDayCO(at);
  return (after === null || day > after) && day <= upTo;
}

/** Recorre los cierres en orden: cada uno parte de lo que contó el anterior. */
export function computeChain(
  closings: ClosingInput[],
  rows: CashMovement[],
  transfers: TransferInput[],
  accounts: ClosingAccount[],
): ChainEntry[] {
  const sorted = [...closings].sort((a, b) => a.day.localeCompare(b.day));
  // La diferencia misma nunca entra a calcular lo esperado.
  const base = rows.filter((r) => r.origin !== 'RECONCILIATION');
  const entries: ChainEntry[] = [];

  sorted.forEach((closing, index) => {
    const previous = index > 0 ? sorted[index - 1] : null;
    const windowRows = base.filter((r) =>
      inWindow(r.at, previous?.day ?? null, closing.day),
    );
    const windowTransfers = transfers.filter((t) =>
      inWindow(t.occurredAt, previous?.day ?? null, closing.day),
    );
    const { byAccount, unassignedNetCOP } = netByAccount(
      windowRows,
      windowTransfers,
      accounts,
    );
    const previousTotal =
      previous?.lines.reduce((s, l) => s + l.countedCOP, 0) ?? 0;
    const movedCOP = windowRows.reduce((s, r) => s + net(r), 0);
    const countedTotalCOP = closing.lines.reduce((s, l) => s + l.countedCOP, 0);
    const expectedTotalCOP = previousTotal + movedCOP;

    entries.push({
      id: closing.id,
      day: closing.day,
      previousDay: previous?.day ?? null,
      isFirst: !previous,
      countedTotalCOP,
      expectedTotalCOP,
      differenceCOP: countedTotalCOP - expectedTotalCOP,
      expectedAtCloseCOP: closing.expectedTotalCOP,
      differenceAtCloseCOP: countedTotalCOP - closing.expectedTotalCOP,
      collectedCOP: windowRows
        .filter((r) => r.origin === 'SALES')
        .reduce((s, r) => s + net(r), 0),
      unassignedNetCOP,
      lines: closing.lines.map((line) => {
        const before = previous?.lines.find(
          (l) => l.accountId === line.accountId,
        );
        const expectedCOP = previous
          ? (before?.countedCOP ?? 0) + (byAccount.get(line.accountId) ?? 0)
          : null;
        return {
          accountId: line.accountId,
          countedCOP: line.countedCOP,
          expectedCOP,
          differenceCOP:
            expectedCOP === null ? null : line.countedCOP - expectedCOP,
          expectedSnapshotCOP: line.expectedSnapshotCOP,
        };
      }),
      rows: windowRows,
    });
  });
  return entries;
}

/** Las filas de plata que representan cada diferencia, para sumarlas a la caja. */
export function differenceRows(chain: ChainEntry[], at: (day: string) => Date) {
  return chain
    .filter((entry) => entry.differenceCOP !== 0)
    .map(
      (entry): CashMovement => ({
        at: at(entry.day),
        direction: entry.differenceCOP > 0 ? 'IN' : 'OUT',
        category: CASH_DIFFERENCE_CATEGORY,
        origin: 'RECONCILIATION',
        amountCOP: Math.abs(entry.differenceCOP),
        refId: entry.id,
      }),
    );
}

/** Saldo de cada cuenta hoy: lo último contado más lo que se movió después. */
export function currentBalances(
  last: ChainEntry | null,
  rows: CashMovement[],
  transfers: TransferInput[],
  accounts: ClosingAccount[],
) {
  if (!last) return null;
  const since = rows.filter(
    (r) => r.origin !== 'RECONCILIATION' && calendarDayCO(r.at) > last.day,
  );
  const sinceTransfers = transfers.filter(
    (t) => calendarDayCO(t.occurredAt) > last.day,
  );
  const { byAccount, unassignedNetCOP } = netByAccount(
    since,
    sinceTransfers,
    accounts,
  );
  const balances = new Map<string, number>();
  for (const account of accounts) {
    const counted =
      last.lines.find((l) => l.accountId === account.id)?.countedCOP ?? 0;
    balances.set(account.id, counted + (byAccount.get(account.id) ?? 0));
  }
  return { balances, unassignedNetCOP };
}

// ─── Histórico por mes ───────────────────────────────────────────────────────

export type MonthStatus = 'OK' | 'SHORTAGE' | 'SURPLUS' | 'NO_CLOSINGS';

export interface MonthSummary {
  month: string;
  status: MonthStatus;
  inProgress: boolean;
  closings: number;
  correctClosings: number;
  /** Lo que faltó: sin explicar + lo que se asumió como pérdida. */
  shortageCOP: number;
  /** De eso, lo que se asumió como gasto "Faltante de caja". */
  assumedCOP: number;
  surplusCOP: number;
  collectedCOP: number;
  /** Faltante sobre lo cobrado. null si no hay cobros para comparar. */
  lossPct: number | null;
  /** Trae el primer cierre, que abarca todo el histórico anterior. */
  includesFirstClosing: boolean;
}

function nextMonth(month: string) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * "Septiembre correcto, octubre con descuadre de X (Y%)". Del primer cierre a
 * hoy, sin saltarse meses: un mes sin cierres no es un mes que cuadró.
 *
 * Lo asumido como faltante vuelve a sumarse: al asumirlo la diferencia queda en
 * cero, pero esa plata se perdió y el mes no puede aparecer como correcto.
 */
export function monthlyHistory(
  chain: ChainEntry[],
  assumedByClosing: Map<string, number>,
  currentMonth: string,
): MonthSummary[] {
  if (!chain.length) return [];
  const months = new Map<string, MonthSummary>();
  const blank = (month: string): MonthSummary => ({
    month,
    status: 'NO_CLOSINGS',
    inProgress: month === currentMonth,
    closings: 0,
    correctClosings: 0,
    shortageCOP: 0,
    assumedCOP: 0,
    surplusCOP: 0,
    collectedCOP: 0,
    lossPct: null,
    includesFirstClosing: false,
  });
  let cursor = chain[0].day.slice(0, 7);
  while (cursor <= currentMonth) {
    months.set(cursor, blank(cursor));
    cursor = nextMonth(cursor);
  }
  for (const entry of chain) {
    const month = entry.day.slice(0, 7);
    const row = months.get(month) ?? blank(month);
    months.set(month, row);
    const assumed = assumedByClosing.get(entry.id) ?? 0;
    const open =
      Math.abs(entry.differenceCOP) > CASH_TOLERANCE_COP
        ? entry.differenceCOP
        : 0;
    row.closings += 1;
    row.assumedCOP += assumed;
    row.shortageCOP += assumed + Math.max(0, -open);
    row.surplusCOP += Math.max(0, open);
    row.collectedCOP += entry.collectedCOP;
    if (open === 0 && assumed === 0) row.correctClosings += 1;
    if (entry.isFirst) row.includesFirstClosing = true;
  }
  for (const row of months.values()) {
    if (row.closings === 0) continue;
    row.status =
      row.shortageCOP > 0 ? 'SHORTAGE' : row.surplusCOP > 0 ? 'SURPLUS' : 'OK';
    row.lossPct =
      row.collectedCOP > 0
        ? Math.round((row.shortageCOP / row.collectedCOP) * 10000) / 100
        : null;
  }
  return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
}

// ─── ¿Qué pudo pasar? ────────────────────────────────────────────────────────

export type HintConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type HintAction =
  | 'EXPENSE'
  | 'WITHDRAWAL'
  | 'LOAN'
  | 'SALES'
  | 'ASSIGN'
  | 'SUGGESTIONS'
  | 'NONE';

export interface ClosingHint {
  code: string;
  confidence: HintConfidence;
  title: string;
  detail: string;
  action: HintAction;
}

export interface HintContext {
  entry: ChainEntry;
  accounts: ClosingAccount[];
  /** Compras y gastos que nadie ha dicho de dónde salieron. */
  pendingSuggestedCOP: number;
  /** Gastos recurrentes activos. */
  templates: Array<{ concept: string; amountCOP: number }>;
  /** Cierres anteriores, del más viejo al más reciente. */
  previous: ChainEntry[];
  /** Para decir el monto en palabras sin depender del frontend. */
  formatCOP: (amount: number) => string;
}

const close = (a: number, b: number) => Math.abs(a - b) <= CASH_TOLERANCE_COP;

function datesBetween(from: string, to: string) {
  const days: string[] = [];
  let cursor = new Date(`${from}T12:00:00-05:00`);
  const end = new Date(`${to}T12:00:00-05:00`);
  while (cursor <= end) {
    days.push(calendarDayCO(cursor));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return days;
}

/**
 * Pistas de por qué no cuadra. Son reglas sobre los datos, sin modelo: Lynko no
 * inventa. Por eso siempre dicen "puede ser": la causa la confirma el dueño.
 */
export function closingHints(ctx: HintContext): ClosingHint[] {
  const { entry, accounts, formatCOP: cop } = ctx;
  const diff = entry.differenceCOP;
  const shortage = -diff;
  const hints: ClosingHint[] = [];
  const name = (id: string) =>
    accounts.find((a) => a.id === id)?.name ?? 'Otra cuenta';
  const off = entry.lines.filter(
    (l) =>
      l.differenceCOP !== null &&
      Math.abs(l.differenceCOP) > CASH_TOLERANCE_COP,
  );

  // Una cuenta da de menos y otra de más por lo mismo: la plata está, pero se
  // anotó donde no era. Puede pasar aunque el total cuadre.
  for (const a of off) {
    const b = off.find(
      (o) =>
        o.accountId > a.accountId &&
        (o.differenceCOP ?? 0) * (a.differenceCOP ?? 0) < 0 &&
        close(Math.abs(o.differenceCOP ?? 0), Math.abs(a.differenceCOP ?? 0)),
    );
    if (!b) continue;
    hints.push({
      code: 'WRONG_ACCOUNT',
      confidence: 'HIGH',
      title: 'Puede ser un cobro o gasto anotado en la cuenta equivocada',
      detail: `${name(a.accountId)} da ${cop(a.differenceCOP ?? 0)} y ${name(b.accountId)} da ${cop(b.differenceCOP ?? 0)}: la plata está, pero en otra cuenta. Revisa el medio de pago de las ventas de esos días.`,
      action: 'SALES',
    });
  }

  if (Math.abs(diff) <= CASH_TOLERANCE_COP) return hints;

  const expenses = entry.rows.filter((r) => r.origin === 'EXPENSE');
  const dayOf = (row: CashMovement) => calendarDayCO(row.at);

  if (diff > 0) {
    // Sobra plata: algo se anotó como salida y no salió, o entró sin anotarse.
    const seen = new Map<string, CashMovement>();
    for (const row of expenses) {
      const key = `${row.label ?? ''}|${row.amountCOP}`;
      const twin = seen.get(key);
      if (twin && close(row.amountCOP, diff)) {
        hints.push({
          code: 'DUPLICATE_EXPENSE',
          confidence: 'HIGH',
          title: 'Puede ser un gasto registrado dos veces',
          detail: `"${row.label ?? 'Gasto'}" por ${cop(row.amountCOP)} aparece el ${dayOf(twin)} y el ${dayOf(row)}, y eso es justo lo que sobra.`,
          action: 'EXPENSE',
        });
        break;
      }
      seen.set(key, row);
    }
    const match = expenses.find((r) => close(r.amountCOP, diff));
    if (match && !hints.some((h) => h.code === 'DUPLICATE_EXPENSE')) {
      hints.push({
        code: 'EXPENSE_NOT_PAID',
        confidence: 'MEDIUM',
        title: 'Puede ser un gasto anotado que no se pagó de aquí',
        detail: `"${match.label ?? 'Gasto'}" del ${dayOf(match)} es por ${cop(match.amountCOP)}, lo mismo que sobra. Quizá aún no se paga, o salió de otro bolsillo.`,
        action: 'EXPENSE',
      });
    }
    if (ctx.pendingSuggestedCOP > 0) {
      hints.push({
        code: 'PENDING_FUNDING',
        confidence: close(ctx.pendingSuggestedCOP, diff) ? 'HIGH' : 'MEDIUM',
        title: 'Puede ser plata que pusiste sin registrar',
        detail: `Hay ${cop(ctx.pendingSuggestedCOP)} en compras sin decir de dónde salió la plata. Confírmalo en Inversión y esta diferencia se ajusta sola.`,
        action: 'SUGGESTIONS',
      });
    }
    hints.push({
      code: 'UNRECORDED_INCOME',
      confidence: 'LOW',
      title: 'Puede ser una venta o un aporte sin registrar',
      detail:
        'Entró plata que Lynko no tiene anotada. Revisa ventas de esos días o aportes que no registraste.',
      action: 'SALES',
    });
  } else {
    // Falta plata: algo salió sin anotarse, o se anotó un cobro que no entró.
    const template = ctx.templates.find((t) => close(t.amountCOP, shortage));
    if (template) {
      hints.push({
        code: 'RECURRING_NOT_RECORDED',
        confidence: 'HIGH',
        title: `Puede ser "${template.concept}" sin registrar`,
        detail: `Ese gasto recurrente es por ${cop(template.amountCOP)}, lo mismo que falta.`,
        action: 'EXPENSE',
      });
    }
    const sale = entry.rows.find(
      (r) =>
        r.origin === 'SALES' &&
        r.direction === 'IN' &&
        close(r.amountCOP, shortage),
    );
    if (sale) {
      hints.push({
        code: 'PAYMENT_NOT_RECEIVED',
        confidence: 'MEDIUM',
        title: 'Puede ser un cobro que no entró',
        detail: `Hay un cobro por ${cop(sale.amountCOP)} del ${dayOf(sale)}, lo mismo que falta. Revisa si de verdad se recibió o si quedó fiado.`,
        action: 'SALES',
      });
    }
    const missing = off.filter((l) => (l.differenceCOP ?? 0) < 0);
    const types = new Set(
      missing.map((l) => accounts.find((a) => a.id === l.accountId)?.type),
    );
    if (missing.length && types.size === 1 && types.has('CASH')) {
      hints.push({
        code: 'CASH_ONLY',
        confidence: 'MEDIUM',
        title: 'Solo falta en efectivo',
        detail:
          'Suele ser una compra menor pagada del cajón, un vuelto mal dado o plata que se sacó sin anotar.',
        action: 'EXPENSE',
      });
    } else if (missing.length && !types.has('CASH')) {
      hints.push({
        code: 'BANK_ONLY',
        confidence: 'MEDIUM',
        title: 'Solo falta en banco o billetera',
        detail:
          'Revisa el extracto: suele ser una cuota de manejo, el 4x1000, una comisión o una transferencia sin anotar.',
        action: 'EXPENSE',
      });
    }
    if (entry.previousDay) {
      const start = calendarDayCO(
        new Date(
          new Date(`${entry.previousDay}T12:00:00-05:00`).getTime() +
            86_400_000,
        ),
      );
      const days = datesBetween(start, entry.day);
      const withExpense = new Set(expenses.map(dayOf));
      const empty = days.filter((d) => !withExpense.has(d)).length;
      if (days.length >= 3 && empty / days.length >= 0.5) {
        hints.push({
          code: 'DAYS_WITHOUT_EXPENSES',
          confidence: 'MEDIUM',
          title: 'Hay días sin ningún gasto anotado',
          detail: `En ${empty} de ${days.length} días no se registró ningún gasto. Puede faltar alguno.`,
          action: 'EXPENSE',
        });
      }
    }
    let streak = 0;
    let streakCOP = 0;
    for (let i = ctx.previous.length - 1; i >= 0; i -= 1) {
      if (ctx.previous[i].differenceCOP >= -CASH_TOLERANCE_COP) break;
      streak += 1;
      streakCOP += -ctx.previous[i].differenceCOP;
    }
    if (streak >= 1) {
      hints.push({
        code: 'REPEATED_SHORTAGE',
        confidence: streak >= 2 ? 'HIGH' : 'MEDIUM',
        title: `Van ${streak + 1} cierres seguidos con faltante`,
        detail: `Antes de este ya faltaron ${cop(streakCOP)}. Cuando se repite, suele ser un gasto o un retiro habitual que no se está anotando.`,
        action: 'NONE',
      });
    }
    hints.push({
      code: 'UNRECORDED_OUTFLOW',
      confidence: 'LOW',
      title: 'Puede ser plata que salió sin anotarse',
      detail:
        'Un gasto, un retiro del dueño o un préstamo a alguien. Si lo recuerdas, regístralo con su fecha y la diferencia baja sola.',
      action: 'WITHDRAWAL',
    });
  }

  const order: Record<HintConfidence, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return hints.sort((a, b) => order[a.confidence] - order[b.confidence]);
}
