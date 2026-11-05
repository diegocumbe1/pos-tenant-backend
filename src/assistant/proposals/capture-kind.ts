import { isExpenseCaptureStart } from './expense-capture';
import { isSaleCaptureStart } from './retail-sale-capture';

/** Qué se está intentando registrar. Null = es una consulta o una conversación. */
export function captureKindOf(
  message: string,
): 'retail_sale' | 'expense' | null {
  if (isSaleCaptureStart(message)) return 'retail_sale';
  if (isExpenseCaptureStart(message)) return 'expense';
  return null;
}
