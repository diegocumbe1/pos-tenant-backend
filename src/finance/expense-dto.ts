import { ExpenseFrequency, ExpenseNature } from '@prisma/client';
import { defaultNatureFor, resolveNature } from './expense-nature';

/** Lo mínimo de una fila de `expenses` para mandarla al frontend. */
export interface ExpenseRow {
  id: string;
  category: string;
  concept: string;
  amountCOP: number;
  incurredAt: Date;
  frequency: ExpenseFrequency;
  isRecurring: boolean;
  dueDate: Date | null;
  note: string | null;
  nature?: ExpenseNature | null;
  templateId?: string | null;
  templateOccurrence?: string | null;
  sourceType?: string | null;
  discountCOP?: number | null;
}

/**
 * La forma en que viaja un gasto. Única para los tres servicios que escriben
 * gastos (manuales, recurrentes, suscripción): si cada uno armara la suya,
 * tarde o temprano una pantalla mostraría un campo que otra no trae.
 */
export function toExpenseDto(e: ExpenseRow) {
  return {
    id: e.id,
    category: e.category,
    concept: e.concept,
    amountCOP: e.amountCOP,
    incurredAt: e.incurredAt.getTime(),
    frequency: e.frequency,
    isRecurring: e.isRecurring,
    dueDate: e.dueDate ? e.dueDate.getTime() : null,
    note: e.note,
    /** Efectiva: la elegida o la de su categoría. Nunca null. */
    nature: resolveNature(e.category, e.nature),
    /** true = el dueño la eligió; false = es la de la categoría. */
    natureIsCustom: !!e.nature && e.nature !== defaultNatureFor(e.category),
    templateId: e.templateId ?? null,
    templateOccurrence: e.templateOccurrence ?? null,
    sourceType: e.sourceType ?? null,
    /** Lo que se dejó de pagar. 0 = sin descuento. */
    discountCOP: e.discountCOP ?? 0,
    /** El valor normal: lo pagado + el descuento. */
    listAmountCOP: e.amountCOP + (e.discountCOP ?? 0),
  };
}
