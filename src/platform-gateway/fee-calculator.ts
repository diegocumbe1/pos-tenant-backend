/**
 * Qué queda de verdad de un cobro con pasarela.
 *
 * La comisión NO es lo único que descuentan. Sobre las transacciones con
 * TARJETA el banco adquirente practica además retenciones de impuestos durante
 * la liquidación (modelo agregador de Wompi). Los otros medios solo pagan
 * comisión.
 *
 * La distinción que importa para decidir si el negocio es rentable:
 *
 *   • Comisión + su IVA  → COSTO. Plata que se pierde y nunca vuelve.
 *   • Retenciones        → NO son costo. Son anticipo de impuestos: bajan el
 *                          depósito de hoy y se cruzan en la declaración.
 *
 * Mezclarlas hace creer que la pasarela cuesta el doble de lo que cuesta. Es el
 * mismo tipo de error que tratar un descuento como gasto.
 *
 * Fuentes: soporte.wompi.co (cobros adicionales sobre transacciones aprobadas,
 * retención en la fuente) — verificado 2026-09-25.
 */

export const FEE_METHODS = [
  'CARD_PRESENT',
  'CARD_ONLINE',
  'PSE',
  'NEQUI',
  'BREB',
  'CASH',
] as const;

export type FeeMethod = (typeof FEE_METHODS)[number];

export const FEE_METHOD_LABEL: Record<FeeMethod, string> = {
  CARD_PRESENT: 'Datáfono (presencial)',
  CARD_ONLINE: 'Tarjeta por link / checkout',
  PSE: 'PSE',
  NEQUI: 'Nequi / billeteras',
  BREB: 'Bre-B / transferencia',
  CASH: 'Efectivo',
};

/** Tarifa de un medio. Los bps son puntos básicos: 265 = 2,65%. */
export interface FeeRate {
  method: FeeMethod;
  /** Comisión porcentual sobre el total cobrado. */
  percentBps: number;
  /** Comisión fija por transacción, en COP. */
  fixedCOP: number;
  /** IVA sobre la comisión (19% = 1900). */
  taxBps: number;
  /** Retención en la fuente sobre la base gravable. Solo tarjeta. */
  retefuenteBps: number;
  /** Retención de ICA sobre la base gravable. Solo tarjeta. */
  reteIcaBps: number;
  /** Retención de IVA, sobre el IVA de la venta (no sobre el total). */
  reteIvaBps: number;
  /** Días hábiles hasta que el dinero está en la cuenta. */
  settlementDays: number;
}

export interface FeeQuoteInput {
  /** Lo que paga el cliente, IVA incluido si la venta lo lleva. */
  amountCOP: number;
  rate: FeeRate;
  /** IVA de la VENTA (1900 = 19%). 0 si el producto es excluido o exento. */
  saleIvaBps?: number;
}

export interface FeeQuote {
  method: FeeMethod;
  amount: number;

  /** Descomposición de la venta. */
  taxableBase: number;
  saleIva: number;

  /** Costo real. */
  commission: number;
  commissionIva: number;
  totalCost: number;

  /** Anticipos de impuestos: bajan el depósito pero se recuperan. */
  retefuente: number;
  reteIca: number;
  reteIva: number;
  totalWithheld: number;

  /** Lo que aparece en el extracto bancario. */
  deposited: number;
  /** Lo que realmente queda una vez cruzadas las retenciones. */
  effectiveNet: number;

  /** Costo como % del cobro. Es el número para comparar medios. */
  costPercent: number;
  /** Cuánto menos llega hoy, incluyendo lo retenido. */
  depositGapPercent: number;

  settlementDays: number;
}

const bps = (value: number, rateBps: number): number =>
  Math.round((value * rateBps) / 10_000);

/**
 * Calcula el desglose completo. Todo se redondea a peso: Colombia no maneja
 * centavos y dejar decimales haría que el simulador nunca cuadre con el extracto.
 */
export function quoteFee(input: FeeQuoteInput): FeeQuote {
  const { amountCOP, rate } = input;
  const saleIvaBps = input.saleIvaBps ?? 0;

  // El IVA viene DENTRO del precio cobrado, así que la base se despeja.
  const taxableBase = Math.round(amountCOP / (1 + saleIvaBps / 10_000));
  const saleIva = amountCOP - taxableBase;

  const commission = bps(amountCOP, rate.percentBps) + rate.fixedCOP;
  const commissionIva = bps(commission, rate.taxBps);
  const totalCost = commission + commissionIva;

  // Retefuente e ICA van sobre el valor antes de impuestos; reteIVA sobre el IVA.
  const retefuente = bps(taxableBase, rate.retefuenteBps);
  const reteIca = bps(taxableBase, rate.reteIcaBps);
  const reteIva = bps(saleIva, rate.reteIvaBps);
  const totalWithheld = retefuente + reteIca + reteIva;

  const deposited = amountCOP - totalCost - totalWithheld;

  return {
    method: rate.method,
    amount: amountCOP,
    taxableBase,
    saleIva,
    commission,
    commissionIva,
    totalCost,
    retefuente,
    reteIca,
    reteIva,
    totalWithheld,
    deposited,
    // Las retenciones vuelven, así que el neto real es el cobro menos el costo.
    effectiveNet: amountCOP - totalCost,
    costPercent: amountCOP > 0 ? (totalCost / amountCOP) * 100 : 0,
    depositGapPercent:
      amountCOP > 0 ? ((totalCost + totalWithheld) / amountCOP) * 100 : 0,
    settlementDays: rate.settlementDays,
  };
}

/**
 * Tarifas de fábrica. Son el punto de partida editable, no la verdad: cada
 * comercio negocia lo suyo y las retenciones dependen del RUT y de las
 * responsabilidades ante la DIAN. El ICA además cambia por municipio.
 *
 * Datos publicados por Wompi a 2026-09: presencial 1,98% + IVA · en línea
 * 2,65% + $700 + IVA. Retenciones solo sobre tarjeta.
 */
export const DEFAULT_FEE_RATES: FeeRate[] = [
  {
    method: 'CARD_PRESENT',
    percentBps: 198,
    fixedCOP: 0,
    taxBps: 1900,
    retefuenteBps: 150,
    reteIcaBps: 20,
    reteIvaBps: 1500,
    settlementDays: 1,
  },
  {
    method: 'CARD_ONLINE',
    percentBps: 265,
    fixedCOP: 700,
    taxBps: 1900,
    retefuenteBps: 150,
    reteIcaBps: 20,
    reteIvaBps: 1500,
    settlementDays: 1,
  },
  {
    method: 'PSE',
    percentBps: 265,
    fixedCOP: 700,
    taxBps: 1900,
    // Los medios que no son tarjeta no pasan por el adquirente: solo comisión.
    retefuenteBps: 0,
    reteIcaBps: 0,
    reteIvaBps: 0,
    settlementDays: 1,
  },
  {
    method: 'NEQUI',
    percentBps: 265,
    fixedCOP: 700,
    taxBps: 1900,
    retefuenteBps: 0,
    reteIcaBps: 0,
    reteIvaBps: 0,
    settlementDays: 1,
  },
  // Bre-B y efectivo entran completos: por eso son el riel por defecto.
  {
    method: 'BREB',
    percentBps: 0,
    fixedCOP: 0,
    taxBps: 0,
    retefuenteBps: 0,
    reteIcaBps: 0,
    reteIvaBps: 0,
    settlementDays: 0,
  },
  {
    method: 'CASH',
    percentBps: 0,
    fixedCOP: 0,
    taxBps: 0,
    retefuenteBps: 0,
    reteIcaBps: 0,
    reteIvaBps: 0,
    settlementDays: 0,
  },
];
