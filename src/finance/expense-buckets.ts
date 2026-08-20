// Mapeo de categoría de gasto → bucket de estructura de costos.
//
// Vive en el backend a propósito. `lib/finance.calculations.ts` del frontend dice
// en su cabecera que estos cálculos "van en un finance.utils.ts del backend" y
// eso nunca pasó; el resultado fue que la pantalla de rentabilidad se quedó sin
// desglose y dibujaba el punto de equilibrio en $0. La regla se define una vez,
// aquí, y viaja en la respuesta.

export type ExpenseBucket =
  | 'supplies' // insumos y compras de inventario
  | 'payroll'
  | 'rent'
  | 'utilities'
  | 'other';

const BUCKET_BY_CATEGORY: Record<string, ExpenseBucket> = {
  KITCHEN: 'supplies',
  INVENTORY_PURCHASE: 'supplies',
  // El flete es costo de adquirir la mercancía, no un gasto operativo suelto:
  // va al mismo bucket que la compra para que la estructura de costos y el
  // punto de equilibrio no lo pierdan.
  INVENTORY_SHIPPING: 'supplies',
  PAYROLL: 'payroll',
  RENT: 'rent',
  UTILITIES: 'utilities',
  PLATFORM: 'other',
  OPERATIONS: 'other',
  MAINTENANCE: 'other',
  EXTRAORDINARY: 'other',
  TAXES: 'other',
  PETTY_CASH: 'other',
  OTHER: 'other',
};

export function bucketForCategory(category: string): ExpenseBucket {
  return BUCKET_BY_CATEGORY[category?.toUpperCase()] ?? 'other';
}

export interface ExpenseBuckets {
  suppliesCOP: number;
  payrollCOP: number;
  rentCOP: number;
  utilitiesCOP: number;
  otherCOP: number;
}

export function emptyBuckets(): ExpenseBuckets {
  return {
    suppliesCOP: 0,
    payrollCOP: 0,
    rentCOP: 0,
    utilitiesCOP: 0,
    otherCOP: 0,
  };
}

export function accumulateBuckets(
  rows: Array<{ category: string; amountCOP: number }>,
): ExpenseBuckets {
  const buckets = emptyBuckets();
  for (const row of rows) {
    switch (bucketForCategory(row.category)) {
      case 'supplies':
        buckets.suppliesCOP += row.amountCOP;
        break;
      case 'payroll':
        buckets.payrollCOP += row.amountCOP;
        break;
      case 'rent':
        buckets.rentCOP += row.amountCOP;
        break;
      case 'utilities':
        buckets.utilitiesCOP += row.amountCOP;
        break;
      default:
        buckets.otherCOP += row.amountCOP;
    }
  }
  return buckets;
}
