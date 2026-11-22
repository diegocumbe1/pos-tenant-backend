import { calendarMonthCO, dayStartCO } from '../common/date.util';

/**
 * Flujo de caja del superadmin: real (lo que ya pasó), esperado (cobros y
 * pagos previstos) y devengado (a qué mes pertenece el servicio). Son tres
 * lecturas distintas y NO se mezclan:
 *  - caja: plata que entró/salió en el mes (paidAt / incurredAt);
 *  - proyectado: caja + lo que está por cobrar y por pagar ese mes;
 *  - devengado: un pago anticipado se reparte entre los meses que cubre.
 * Todo se calcula de registros reales; no hay cifras fijas.
 */

export type CashflowPayment = {
  tenantId: string;
  amount: number;
  currency: string;
  paidAt: Date;
  periodStart: Date;
  periodEnd: Date;
  kind: string;
  countsAsRevenue: boolean;
};

export type CashflowExpense = {
  id: string;
  concept: string;
  vendor?: string | null;
  category: string;
  amount: number;
  currency: string;
  status: string; // 'paid' | 'pending'
  kind: string;
  nature?: string | null;
  incurredAt: Date;
  exchangeRate?: number | null;
};

export type CashflowSubscription = {
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  status: string;
  billingCycle: string; // 'monthly' | 'yearly'
  currentPeriodEnd: Date | null;
};

export type CashflowCommitment = {
  concept: string;
  vendor?: string | null;
  category: string;
  amount: number;
  currency: string;
  recurrence: string;
  nextChargeAt: Date;
  endsAt?: Date | null;
};

export type CashflowInput = {
  month: string; // YYYY-MM
  now: Date;
  rate: number; // COP por USD
  payments: CashflowPayment[];
  expenses: CashflowExpense[];
  subscriptions: CashflowSubscription[];
  commitments: CashflowCommitment[];
  monthsBack?: number;
  monthsAhead?: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const MS_DAY = 86_400_000;

export function addMonthsYM(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

function monthStart(ym: string): Date {
  return dayStartCO(`${ym}-01`);
}

function addMonthsDate(d: Date, n: number): Date {
  const next = new Date(d);
  next.setUTCMonth(next.getUTCMonth() + n);
  return next;
}

const RECURRENCE_STEP_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

function toCop(
  amount: number,
  currency: string,
  rate: number,
  own?: number | null,
) {
  return currency === 'USD' ? amount * (own ?? rate) : amount;
}

/** Meses que cubre un pago (164.000 por 4 meses = 41.000/mes). */
function monthsCovered(p: CashflowPayment): number {
  const days = (p.periodEnd.getTime() - p.periodStart.getTime()) / MS_DAY;
  return Math.max(1, Math.round(days / 30.4));
}

export type ClientLine = {
  tenantId: string;
  tenantName: string;
  amountCOP: number;
  /** paid = cobrado en el mes · prepaid = cubierto por un pago anterior ·
   *  pending = vence en el mes y no se ha cobrado · overdue = ya vencido. */
  status: 'paid' | 'prepaid' | 'pending' | 'overdue';
  dueDate?: string;
};

export type ExpenseLine = {
  id?: string;
  concept: string;
  vendor?: string;
  amountCOP: number;
  amount: number;
  currency: string;
  status: 'paid' | 'pending' | 'overdue' | 'projected';
  nature?: string;
  date: string;
};

function validObligations(input: CashflowInput) {
  const realByTenant = new Map<string, CashflowPayment[]>();
  for (const p of input.payments) {
    if (!p.countsAsRevenue || p.amount <= 0) continue;
    const list = realByTenant.get(p.tenantId) ?? [];
    list.push(p);
    realByTenant.set(p.tenantId, list);
  }
  const out: Array<{
    sub: CashflowSubscription;
    monthlyCOP: number;
    cycleMonths: number;
  }> = [];
  for (const sub of input.subscriptions) {
    // Obligación válida = cuenta activa que ya pagó alguna vez. Una cuenta
    // gratis/interna/de prueba nunca pagó, así que no genera ingreso esperado.
    if (sub.status !== 'ACTIVE' || sub.tenantStatus !== 'ACTIVE') continue;
    if (!sub.currentPeriodEnd) continue;
    const real = realByTenant.get(sub.tenantId);
    if (!real?.length) continue;
    const last = [...real].sort(
      (a, b) => b.paidAt.getTime() - a.paidAt.getTime(),
    )[0];
    const monthly =
      toCop(last.amount, last.currency, input.rate) / monthsCovered(last);
    out.push({
      sub,
      monthlyCOP: monthly,
      cycleMonths: sub.billingCycle === 'yearly' ? 12 : 1,
    });
  }
  return out;
}

export function summarizeMonth(input: CashflowInput, month: string) {
  const currentMonth = calendarMonthCO(input.now);
  const start = monthStart(month);
  const end = monthStart(addMonthsYM(month, 1));
  const inMonth = (d: Date) => d >= start && d < end;
  const isPast = month < currentMonth;
  const rate = input.rate;

  // ── Ingresos ──────────────────────────────────────────────────────────────
  const nameOf = new Map(
    input.subscriptions.map((s) => [s.tenantId, s.tenantName]),
  );
  const clients: ClientLine[] = [];
  let received = 0;
  const paidTenants = new Set<string>();
  for (const p of input.payments) {
    if (!p.countsAsRevenue || p.amount <= 0 || !inMonth(p.paidAt)) continue;
    const cop = toCop(p.amount, p.currency, rate);
    received += cop;
    paidTenants.add(p.tenantId);
    clients.push({
      tenantId: p.tenantId,
      tenantName: nameOf.get(p.tenantId) ?? p.tenantId,
      amountCOP: round2(cop),
      status: 'paid',
    });
  }

  // Cobros previstos (solo mes en curso y futuros). Cada uno entra como un
  // "pago virtual" con su propio periodo, para repartir el devengado igual que
  // un pago real.
  type Slice = { amountCOP: number; start: Date; end: Date };
  const slices: Slice[] = [];
  for (const p of input.payments) {
    if (!p.countsAsRevenue || p.amount <= 0) continue;
    slices.push({
      amountCOP: toCop(p.amount, p.currency, rate),
      start: p.periodStart,
      end: p.periodEnd,
    });
    // Pago anticipado que cubre este mes: no es caja de este mes, pero se ve.
    if (
      p.paidAt < start &&
      p.periodStart < end &&
      p.periodEnd >= end && // cubre el mes completo
      !paidTenants.has(p.tenantId)
    ) {
      clients.push({
        tenantId: p.tenantId,
        tenantName: nameOf.get(p.tenantId) ?? p.tenantId,
        amountCOP: 0,
        status: 'prepaid',
      });
      paidTenants.add(p.tenantId);
    }
  }

  let pending = 0;
  let overdueIncome = 0;
  if (!isPast) {
    for (const o of validObligations(input)) {
      const amount = o.monthlyCOP * o.cycleMonths;
      let due = new Date(o.sub.currentPeriodEnd as Date);
      let carriedUsed = false;
      for (let guard = 0; due < end && guard < 600; guard += 1) {
        const next = addMonthsDate(due, o.cycleMonths);
        const inThisMonth = due >= start;
        // Un vencido anterior al mes se arrastra una sola vez, al mes en curso.
        const carried = !inThisMonth && month === currentMonth && !carriedUsed;
        if (inThisMonth || carried) {
          if (carried) carriedUsed = true;
          const isOverdue = due < input.now;
          pending += amount;
          if (isOverdue) overdueIncome += amount;
          slices.push({ amountCOP: amount, start: due, end: next });
          clients.push({
            tenantId: o.sub.tenantId,
            tenantName: o.sub.tenantName,
            amountCOP: round2(amount),
            status: isOverdue ? 'overdue' : 'pending',
            dueDate: due.toISOString(),
          });
        }
        due = next;
      }
    }
  }

  let accrualRevenue = 0;
  for (const sl of slices) {
    const total = sl.end.getTime() - sl.start.getTime();
    const overlap =
      Math.min(sl.end.getTime(), end.getTime()) -
      Math.max(sl.start.getTime(), start.getTime());
    if (total > 0 && overlap > 0)
      accrualRevenue += sl.amountCOP * (overlap / total);
  }

  // ── Gastos ────────────────────────────────────────────────────────────────
  const lines: ExpenseLine[] = [];
  let paidExp = 0;
  let pendingExp = 0;
  let overdueExp = 0;
  let projectedExp = 0;
  for (const e of input.expenses) {
    if (!inMonth(e.incurredAt)) continue;
    const cop = toCop(e.amount, e.currency, rate, e.exchangeRate);
    const isPending = e.status === 'pending';
    const overdue = isPending && e.incurredAt < input.now;
    if (isPending) pendingExp += cop;
    else paidExp += cop;
    if (overdue) overdueExp += cop;
    lines.push({
      id: e.id,
      concept: e.concept,
      vendor: e.vendor ?? undefined,
      amount: e.amount,
      currency: e.currency,
      amountCOP: round2(cop),
      status: isPending ? (overdue ? 'overdue' : 'pending') : 'paid',
      nature: e.nature ?? undefined,
      date: e.incurredAt.toISOString(),
    });
  }
  // Recurrentes que aún no se han generado (próximos ciclos del mes).
  if (!isPast) {
    for (const c of input.commitments) {
      const step = RECURRENCE_STEP_MONTHS[c.recurrence];
      let d = new Date(c.nextChargeAt);
      let guard = 0;
      while (d < end && guard++ < 600) {
        if (c.endsAt && d > c.endsAt) break;
        if (d >= start && d >= input.now) {
          const cop = toCop(c.amount, c.currency, rate);
          projectedExp += cop;
          lines.push({
            concept: c.concept,
            vendor: c.vendor ?? undefined,
            amount: c.amount,
            currency: c.currency,
            amountCOP: round2(cop),
            status: 'projected',
            nature: 'recurring',
            date: d.toISOString(),
          });
        }
        d = step ? addMonthsDate(d, step) : new Date(d.getTime() + 7 * MS_DAY); // weekly
      }
    }
  }

  const expected = received + pending;
  const expensesTotal = paidExp + pendingExp + projectedExp;
  return {
    month,
    isPast,
    isCurrent: month === currentMonth,
    isFuture: month > currentMonth,
    rate,
    income: {
      received: round2(received),
      pending: round2(pending),
      overdue: round2(overdueIncome),
      expected: round2(expected),
      clients,
    },
    expenses: {
      paid: round2(paidExp),
      pending: round2(pendingExp),
      overdue: round2(overdueExp),
      projected: round2(projectedExp),
      total: round2(expensesTotal),
      lines: lines.sort((a, b) => a.date.localeCompare(b.date)),
    },
    /** Caja real: solo plata que ya entró menos plata que ya salió. */
    cashBalance: round2(received - paidExp),
    /** Cierre proyectado: esperado menos gastos previstos del mes. */
    projectedBalance: round2(expected - expensesTotal),
    /** Resultado operativo: ingreso devengado menos gastos del periodo. */
    operating: {
      revenue: round2(accrualRevenue),
      expenses: round2(expensesTotal),
      result: round2(accrualRevenue - expensesTotal),
    },
    /** Cuánto falta ingresar para cubrir los gastos previstos (0 si ya cubre). */
    coverageGap: round2(Math.max(0, expensesTotal - expected)),
  };
}

export function buildCashflow(input: CashflowInput) {
  const currentMonth = calendarMonthCO(input.now);
  const back = input.monthsBack ?? 11;
  const ahead = input.monthsAhead ?? 3;

  const firstDates = [
    ...input.payments.map((p) => p.paidAt),
    ...input.expenses.map((e) => e.incurredAt),
  ];
  const firstMonth = firstDates.length
    ? calendarMonthCO(new Date(Math.min(...firstDates.map((d) => d.getTime()))))
    : currentMonth;
  const from = [firstMonth, addMonthsYM(currentMonth, -back)].sort().pop()!;
  const to = addMonthsYM(currentMonth, ahead);

  const series: Array<{
    month: string;
    received: number;
    expensesPaid: number;
    balance: number;
    projectedIncome: number;
    projectedExpenses: number;
    projectedClose: number;
    operatingResult: number;
    cumulativeCash: number;
    cumulativeOperating: number;
    cumulativeReceived: number;
    cumulativePaid: number;
  }> = [];

  // El acumulado parte desde el primer movimiento, no desde la ventana.
  let cumCash = 0;
  let cumOp = 0;
  let cumReceived = 0;
  let cumPaid = 0;
  for (let m = firstMonth; m <= to; m = addMonthsYM(m, 1)) {
    const s = summarizeMonth(input, m);
    cumCash += s.cashBalance;
    cumOp += s.operating.result;
    cumReceived += s.income.received;
    cumPaid += s.expenses.paid;
    if (m < from) continue;
    series.push({
      month: m,
      received: s.income.received,
      expensesPaid: s.expenses.paid,
      balance: s.cashBalance,
      projectedIncome: s.income.pending,
      projectedExpenses: round2(s.expenses.pending + s.expenses.projected),
      projectedClose: s.projectedBalance,
      operatingResult: s.operating.result,
      cumulativeCash: round2(cumCash),
      cumulativeOperating: round2(cumOp),
      cumulativeReceived: round2(cumReceived),
      cumulativePaid: round2(cumPaid),
    });
  }

  return {
    month: input.month,
    current: summarizeMonth(input, input.month),
    series,
    /** Acumulado real desde el primer movimiento hasta hoy (sin proyección). */
    lifetime: (() => {
      let cash = 0;
      let op = 0;
      let rec = 0;
      let paid = 0;
      for (let m = firstMonth; m <= currentMonth; m = addMonthsYM(m, 1)) {
        const s = summarizeMonth(input, m);
        cash += s.cashBalance;
        op += s.operating.result;
        rec += s.income.received;
        paid += s.expenses.paid;
      }
      return {
        since: firstMonth,
        received: round2(rec),
        paid: round2(paid),
        cashBalance: round2(cash),
        operatingResult: round2(op),
      };
    })(),
  };
}
