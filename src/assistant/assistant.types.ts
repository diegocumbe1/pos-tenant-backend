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
  /**
   * MERCANCÍA vendida: abonos del período, menos devoluciones y **menos flete**.
   *
   * Es la misma base que muestra la pantalla de Ventas. El flete no se vende, se
   * traslada: entra a la caja pero su gasto lo compensa el dashboard, así que
   * contarlo como venta inflaría el ingreso y el ticket promedio.
   */
  revenueCOP: number;
  /**
   * Flete que los clientes pagaron en el período. Va aparte y NO está en
   * `revenueCOP`: el canal puede nombrarlo, pero nunca sumarlo a las ventas.
   */
  shippingCOP: number;
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

// ─── Catálogo ───────────────────────────────────────────────────────────────
// Se recorre por niveles y cada nivel trae el CONTEO más unos pocos ejemplos.
// Por voz, una lista de ciento veinte productos no sirve para nada; lo que
// sirve es saber cuántos hay y poder bajar un escalón.

export interface CatalogOverviewAnswer {
  business: BusinessRefLike;
  productCount: number;
  /** Solo las que tienen productos, de mayor a menor. */
  categories: { id: string; name: string; productCount: number }[];
}

export interface CatalogCategoryAnswer {
  business: BusinessRefLike;
  category: { id: string; name: string } | null;
  productCount: number;
  /** De mayor a menor stock: lo que hay de verdad va primero. */
  products: { name: string; priceCOP: number; stock: number }[];
}

export interface ProductLookupAnswer {
  business: BusinessRefLike;
  /** Cuántos coincidieron con la búsqueda, aunque solo se devuelvan algunos. */
  matchCount: number;
  /** Null cuando no hubo match, o cuando hay demasiados para elegir uno. */
  product: {
    name: string;
    priceCOP: number;
    stock: number;
    trackStock: boolean;
    categoryName: string | null;
    variants: { label: string; stock: number }[];
  } | null;
  /** Nombres para desambiguar cuando coincidió más de uno. */
  candidates: string[];
}

export interface SalesRankingAnswer {
  business: BusinessRefLike;
  period: ReportPeriod;
  /** De más a menos unidades, ya netas de devoluciones. */
  products: { name: string; units: number; revenueCOP: number }[];
  /** Presentaciones —aromas, tallas, colores— de más a menos vendidas. */
  variants: { label: string; units: number }[];
  /** De mayor a menor facturado en el período. */
  customers: { name: string; salesCount: number; totalCOP: number }[];
  /**
   * Productos del catálogo sin una sola unidad vendida en el período. Es la
   * respuesta que de verdad busca quien pregunta "¿cuál es el menos vendido?".
   */
  unsoldCount: number;
  /**
   * QUÉ no se vendió, no solo cuántos. De más a menos stock detenido: más
   * unidades quietas es más plata dormida, y es por donde hay que empezar.
   */
  unsoldProducts: { name: string; stock: number }[];
  /** Presentaciones —aromas, tallas, colores— que nadie pidió en el período. */
  unsoldVariants: { product: string; label: string; stock: number }[];
  /** Ventas sin cliente asociado: no entran al ranking de clientes. */
  counterSales: number;
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
