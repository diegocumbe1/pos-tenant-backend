import { Injectable } from '@nestjs/common';
import {
  addCalendarDaysCO,
  calendarDayCO,
  dayStartCO,
  formatCOP,
  formatDateLongCO,
} from '../../common/date.util';
import { CaptureOrigin } from '../../common/capture-origin';
import { FinanceService } from '../../finance/finance.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AssistantScopeService } from '../assistant-scope.service';
import { AgentIntent } from '../intents/intent-resolver.service';
import {
  EXPENSE_CATEGORY_OPTIONS,
  cleanConcept,
  matchAccount,
  parseAmount,
  parseExpenseMessage,
} from './expense-capture';
import {
  FlowExecution,
  FlowPayload,
  FlowStep,
  Option,
  ProposalFlow,
  ProposalScope,
  askStep,
  isOtherQuestion,
  pickOption,
} from './proposal-flow';

/** Solo valores resueltos. La frase original no se guarda. */
export interface ExpensePayload extends FlowPayload {
  amountCOP?: number;
  concept?: string;
  category?: string;
  categoryLabel?: string;
  /** Día calendario en Colombia. */
  day: string;
  branchName?: string;
  /** Sede elegida en el menú; `next` la pasa a la columna `branchId`. */
  branchIdChosen?: string;
  /** `undefined` = falta decidir. `null` = el negocio no tiene cuentas. */
  moneyAccountId?: string | null;
  moneyAccountName?: string;
  paidOutsideBusiness?: boolean;
  accountHint?: string;
}

const OUTSIDE = '__outside__';

/** "50" a secas: pudo ser cincuenta pesos o cincuenta mil. */
export function ambiguousOptions(amountCOP: number): Option[] {
  return [amountCOP, amountCOP * 1000].map((value) => ({
    value: String(value),
    label: formatCOP(value),
  }));
}

/** Hoy es ahora. Otro día va a mediodía para no caer en el día vecino. */
function incurredAtOf(day: string): number {
  return day === calendarDayCO(new Date())
    ? Date.now()
    : dayStartCO(day).getTime() + 12 * 3_600_000;
}

@Injectable()
export class ExpenseFlow implements ProposalFlow<ExpensePayload> {
  readonly kind = 'expense';
  readonly intent: AgentIntent = 'capture_expense';
  readonly permission = 'restaurant:finance:write';
  readonly permissionDenied =
    'Tu usuario no tiene permiso para registrar gastos.';
  readonly words = { this: 'este', verb: 'registrarlo', the: 'el' };

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AssistantScopeService,
    private readonly finance: FinanceService,
  ) {}

  guard(): string | null {
    return null;
  }

  start(message: string): ExpensePayload {
    const parsed = parseExpenseMessage(message);
    const today = calendarDayCO(new Date());
    const payload: ExpensePayload = {
      day: parsed.daysAgo ? addCalendarDaysCO(today, -parsed.daysAgo) : today,
      ...(parsed.concept ? { concept: parsed.concept } : {}),
      ...(parsed.accountHint ? { accountHint: parsed.accountHint } : {}),
    };
    if (parsed.amount && !parsed.amount.ambiguous) {
      payload.amountCOP = parsed.amount.amountCOP;
    } else if (parsed.amount) {
      payload.options = ambiguousOptions(parsed.amount.amountCOP);
    }
    return payload;
  }

  applyAnswer(
    payload: ExpensePayload,
    message: string,
    intent: AgentIntent,
  ): ExpensePayload | null {
    switch (payload.awaiting) {
      case 'amount': {
        const picked = payload.options && pickOption(message, payload.options);
        if (picked) {
          return {
            ...payload,
            amountCOP: Number(picked.value),
            options: undefined,
          };
        }
        const parsed = parseAmount(message);
        if (!parsed) return null;
        return parsed.ambiguous
          ? { ...payload, options: ambiguousOptions(parsed.amountCOP) }
          : { ...payload, amountCOP: parsed.amountCOP, options: undefined };
      }
      case 'concept': {
        if (isOtherQuestion(message, intent)) return null;
        const concept = cleanConcept(message);
        return concept ? { ...payload, concept, options: undefined } : null;
      }
      case 'category': {
        const picked = pickOption(message, payload.options ?? []);
        return picked
          ? {
              ...payload,
              category: picked.value,
              categoryLabel: picked.label,
              options: undefined,
            }
          : null;
      }
      case 'branch': {
        const picked = pickOption(message, payload.options ?? []);
        return picked
          ? {
              ...payload,
              branchName: picked.label,
              branchIdChosen: picked.value,
              options: undefined,
            }
          : null;
      }
      case 'account': {
        const picked = pickOption(message, payload.options ?? []);
        if (!picked) return null;
        return picked.value === OUTSIDE
          ? {
              ...payload,
              moneyAccountId: null,
              paidOutsideBusiness: true,
              options: undefined,
            }
          : {
              ...payload,
              moneyAccountId: picked.value,
              moneyAccountName: picked.label,
              options: undefined,
            };
      }
      default:
        return null;
    }
  }

  async next(
    current: ExpensePayload,
    scope: ProposalScope,
    rowBranchId: string | null,
  ): Promise<FlowStep<ExpensePayload>> {
    const payload = { ...current };
    let branchId = payload.branchIdChosen ?? rowBranchId;
    delete payload.branchIdChosen;

    if (payload.amountCOP === undefined) {
      return askStep(
        payload,
        branchId,
        'amount',
        payload.options
          ? '¿De cuánto fue el gasto?'
          : '¿De cuánto fue el gasto? Por ejemplo: 50 mil.',
      );
    }
    if (!payload.concept) {
      return askStep(payload, branchId, 'concept', '¿En qué fue el gasto?');
    }
    if (!payload.category) {
      return askStep(
        payload,
        branchId,
        'category',
        `¿En qué categoría va "${payload.concept}"?`,
        [...EXPENSE_CATEGORY_OPTIONS],
      );
    }

    if (!branchId) {
      const branches = await this.branchesFor(scope);
      if (!branches.length) {
        return {
          type: 'abort',
          text: 'Tu usuario no tiene ninguna sede para registrar gastos.',
        };
      }
      if (branches.length > 1) {
        return askStep(
          payload,
          null,
          'branch',
          '¿En cuál sede?',
          branches.map((b) => ({ value: b.id, label: b.name })),
        );
      }
      branchId = branches[0].id;
      payload.branchName = branches[0].name;
    }

    if (payload.moneyAccountId === undefined) {
      const accounts = await this.prisma.moneyAccount.findMany({
        where: { tenantId: scope.business.id, branchId, isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, type: true, defaultForMethods: true },
      });
      if (!accounts.length) {
        payload.moneyAccountId = null;
      } else {
        const named = payload.accountHint
          ? matchAccount(payload.accountHint, accounts)
          : null;
        if (!named) {
          return askStep(
            payload,
            branchId,
            'account',
            '¿De dónde salió la plata?',
            [
              ...accounts.map((a) => ({ value: a.id, label: a.name })),
              { value: OUTSIDE, label: 'Por fuera del negocio' },
            ],
          );
        }
        payload.moneyAccountId = named.id;
        payload.moneyAccountName = named.name;
      }
    }

    const ready: ExpensePayload = {
      ...payload,
      awaiting: undefined,
      options: undefined,
    };
    delete ready.accountHint;
    const source = ready.paidOutsideBusiness
      ? 'Por fuera del negocio'
      : ready.moneyAccountName;
    return {
      type: 'ready',
      payload: ready,
      branchId,
      lines: [
        `Lynko armó este gasto en ${scope.business.name}:`,
        `${ready.concept}: *${formatCOP(ready.amountCOP as number)}*`,
        `Categoría: ${ready.categoryLabel}`,
        ...(ready.branchName ? [`Sede: ${ready.branchName}`] : []),
        `Fecha: ${formatDateLongCO(dayStartCO(ready.day))}`,
        ...(source ? [`Sale de: ${source}`] : []),
      ],
    };
  }

  summary(payload: ExpensePayload): string {
    return `gasto de ${formatCOP(payload.amountCOP ?? 0)} (${payload.concept ?? 'sin concepto'})`;
  }

  async execute(
    payload: ExpensePayload,
    scope: ProposalScope,
    branchId: string,
    code: string,
    origin: CaptureOrigin,
  ): Promise<FlowExecution> {
    const ctx = await this.scope.contextFor(
      scope.actor,
      scope.business.id,
      branchId,
    );
    const expense = await this.finance.createExpense(
      ctx,
      {
        category: payload.category as string,
        concept: payload.concept as string,
        amountCOP: payload.amountCOP as number,
        incurredAt: incurredAtOf(payload.day),
        ...(payload.paidOutsideBusiness
          ? { paidOutsideBusiness: true }
          : payload.moneyAccountId
            ? { moneyAccountId: payload.moneyAccountId }
            : {}),
      },
      origin,
    );
    return {
      resultRef: expense.id,
      reply: `Listo. Quedó registrado el ${this.summary(payload)} en ${scope.business.name}, del borrador ${code}.`,
    };
  }

  private branchesFor(scope: ProposalScope) {
    const { actor, business } = scope;
    return this.prisma.branch.findMany({
      where: {
        tenantId: business.id,
        ...(actor.isRoot ? {} : { id: { in: actor.accessibleBranches } }),
      },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
  }
}
