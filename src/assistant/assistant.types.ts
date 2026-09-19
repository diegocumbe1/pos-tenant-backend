/**
 * Respuestas del asistente: cifras, nunca texto redactado.
 *
 * Cada canal (Alexa por voz, chat web en pantalla) las formatea a su manera.
 * Ver docs/ALEXA_VOICE_ACTIVATION.md §"Plan siguiente".
 */

export type ReportPeriod = 'day' | 'week' | 'month';

export interface BusinessRefLike {
  id: string;
  name: string;
}

// ─── Bloques ────────────────────────────────────────────────────────────────
// Se componen solos y dentro del reporte, para que las dos rutas devuelvan
// exactamente lo mismo y no puedan divergir.

export interface SalesFigures {
  salesCount: number;
  /** Ventas netas: abonos del período menos devoluciones, como en el dashboard. */
  revenueCOP: number;
  unitsSold: number;
  averageTicketCOP: number;
  marginPct: number;
  /** Lo que quedó debiendo el período consultado, no la cartera total. */
  creditedCOP: number;
}

export interface DebtFigures {
  totalCOP: number;
  salesCount: number;
  /** De mayor a menor saldo. Vacío no significa cero deuda: ver `unidentified`. */
  customers: { name: string; amountCOP: number; salesCount: number }[];
  /** Ventas de mostrador sin cliente asociado: deuda sin a quién llamar. */
  unidentified: { amountCOP: number; salesCount: number };
}

export interface InventoryFigures {
  trackedProducts: number;
  totalUnits: number;
  valueAtCostCOP: number;
  valueAtPriceCOP: number;
  /** Por debajo del mínimo, agotados incluidos. De menor a mayor stock. */
  lowStock: { name: string; stock: number; minStock: number }[];
  lowStockCount: number;
  outOfStockCount: number;
}

export interface DeliveryFigures {
  salesCount: number;
  totalCOP: number;
  /** Clientes con entregas pendientes, de mayor a menor monto. */
  customers: { name: string; salesCount: number; totalCOP: number }[];
}

export interface PurchaseFigures {
  /** Pendientes + pedidos + recibidos a medias: lo que sigue abierto. */
  openCount: number;
  estimatedOpenCostCOP: number;
}

// ─── Respuestas ─────────────────────────────────────────────────────────────

export interface SalesAnswer extends SalesFigures {
  business: BusinessRefLike;
  period: ReportPeriod;
}

export interface PendingPaymentAnswer extends DebtFigures {
  business: BusinessRefLike;
}

export interface InventoryStatusAnswer extends InventoryFigures {
  business: BusinessRefLike;
}

export interface PendingDeliveryAnswer extends DeliveryFigures {
  business: BusinessRefLike;
}

/**
 * Los cinco bloques del reporte hablado.
 *
 * Solo `sales` depende del período. La cartera, el stock bajo, los pedidos
 * abiertos y lo que falta entregar son una foto de hoy: la venta fiada de marzo
 * se sigue debiendo en septiembre, y un producto agotado no está agotado
 * "durante la semana". Acotarlos al período daría cifras que suenan bien y
 * están mal.
 */
export interface BusinessReportAnswer {
  business: BusinessRefLike;
  period: ReportPeriod;
  sales: SalesFigures;
  debt: DebtFigures;
  inventory: InventoryFigures;
  purchases: PurchaseFigures;
  delivery: DeliveryFigures;
}

export interface PlatformOverviewAnswer {
  tenants: { total: number; active: number; suspended: number };
  subscriptions: {
    active: number;
    trialing: number;
    pastDue: number;
    /** Activas + en prueba + en mora: las que hoy generan o van a generar ingreso. */
    billable: number;
  };
  mrrCOP: number;
  payments: { month: string; count: number; totalCOP: number };
}
