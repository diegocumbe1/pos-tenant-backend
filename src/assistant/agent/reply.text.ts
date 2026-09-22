import { formatCOP } from '../../common/date.util';
import {
  InventoryStatusAnswer,
  PendingDeliveryAnswer,
  PendingPaymentAnswer,
  SalesAnswer,
  SalesRankingAnswer,
} from '../assistant.types';
import { periodLabel } from '../report-period';
import { AgentIntent } from '../intents/intent-resolver.service';

/**
 * De cifras a texto de chat.
 *
 * Vive en el agente y no en `AssistantService` por la misma razón por la que
 * Alexa tiene sus propias frases: la capacidad devuelve números, el canal los
 * redacta. Lo que se escribe en un chat y lo que se dice en voz alta no se
 * parecen —aquí caben saltos de línea y listas; por voz, no—, y forzar un solo
 * texto para los dos los empeora a ambos.
 *
 * Regla de todo este archivo: **no se calcula nada**. Si un número no vino del
 * servicio, no se escribe.
 */

export function salesText(sales: SalesAnswer): string {
  // `periodLabel` es el mismo de Alexa: "hoy", "ayer", "en lo que va del mes".
  // Se usa tal cual para que la frase del chat y la hablada nombren el MISMO
  // rango; que difieran es cómo se empieza a desconfiar de las dos.
  const label = periodLabel(sales.period);
  if (!sales.salesCount) {
    return `${capitalize(label)} ${sales.business.name} no registra ventas todavía.`;
  }
  const lines = [
    `${capitalize(label)} ${sales.business.name} lleva *${formatCOP(sales.revenueCOP)}* en ${sales.salesCount} ${plural(sales.salesCount, 'venta', 'ventas')}.`,
    `Ticket promedio: ${formatCOP(sales.averageTicketCOP)} · Margen: ${sales.marginPct}%`,
  ];
  // El flete entra a la caja pero no es mercancía vendida: se nombra aparte
  // para que nadie lo sume al ingreso. Ver SalesFigures en assistant.types.ts.
  if (sales.shippingCOP > 0) {
    lines.push(
      `Además entraron ${formatCOP(sales.shippingCOP)} de flete, que no cuentan como venta.`,
    );
  }
  if (sales.creditedCOP > 0) {
    lines.push(
      `Quedaron ${formatCOP(sales.creditedCOP)} por cobrar de ese período.`,
    );
  }
  return lines.join('\n');
}

export function debtText(debt: PendingPaymentAnswer): string {
  if (!debt.totalCOP)
    return `${debt.business.name} no tiene saldos por cobrar.`;
  const lines = [
    `${debt.business.name} tiene *${formatCOP(debt.totalCOP)}* por cobrar en ${debt.salesCount} ${plural(debt.salesCount, 'venta', 'ventas')}.`,
  ];
  for (const customer of debt.customers.slice(0, 5)) {
    lines.push(`• ${customer.name}: ${formatCOP(customer.amountCOP)}`);
  }
  if (debt.customers.length > 5) {
    lines.push(`… y ${debt.customers.length - 5} más.`);
  }
  if (debt.unidentified.amountCOP > 0) {
    lines.push(
      `${formatCOP(debt.unidentified.amountCOP)} son de ventas de mostrador sin cliente asociado.`,
    );
  }
  return lines.join('\n');
}

export function deliveryText(delivery: PendingDeliveryAnswer): string {
  if (!delivery.salesCount)
    return `${delivery.business.name} no tiene entregas pendientes.`;
  const lines = [
    `Faltan por entregar ${delivery.salesCount} ${plural(delivery.salesCount, 'pedido', 'pedidos')} por *${formatCOP(delivery.totalCOP)}*.`,
  ];
  for (const customer of delivery.customers.slice(0, 5)) {
    lines.push(`• ${customer.name}: ${formatCOP(customer.totalCOP)}`);
  }
  return lines.join('\n');
}

export function lowStockText(inventory: InventoryStatusAnswer): string {
  if (!inventory.lowStockCount && !inventory.outOfStockCount) {
    return `Nada por agotarse en ${inventory.business.name}.`;
  }
  const lines = [
    `${inventory.lowStockCount} ${plural(inventory.lowStockCount, 'producto', 'productos')} por debajo del mínimo, ${inventory.outOfStockCount} ya agotados.`,
  ];
  for (const item of inventory.lowStock.slice(0, 5)) {
    lines.push(`• ${item.name}: ${item.stock} (mínimo ${item.minStock})`);
  }
  if (inventory.lowStock.length > 5) {
    lines.push(`… y ${inventory.lowStock.length - 5} más.`);
  }
  return lines.join('\n');
}

export function inventoryValueText(inventory: InventoryStatusAnswer): string {
  return [
    `${inventory.business.name} tiene ${inventory.totalUnits} unidades en ${inventory.trackedProducts} productos.`,
    `Valor al costo: *${formatCOP(inventory.valueAtCostCOP)}* · a precio de venta: ${formatCOP(inventory.valueAtPriceCOP)}`,
  ].join('\n');
}

export function rankingText(ranking: SalesRankingAnswer): string {
  const label = periodLabel(ranking.period);
  if (!ranking.products.length) {
    return `No hay ventas ${label} en ${ranking.business.name} para armar un ranking.`;
  }
  const lines = [`Lo que más salió ${label} en ${ranking.business.name}:`];
  ranking.products.slice(0, 5).forEach((product, index) => {
    lines.push(
      `${index + 1}. ${product.name} — ${product.units} ${plural(product.units, 'unidad', 'unidades')} (${formatCOP(product.revenueCOP)})`,
    );
  });
  if (ranking.unsoldCount > 0) {
    lines.push(
      `${ranking.unsoldCount} ${plural(ranking.unsoldCount, 'producto', 'productos')} no ${plural(ranking.unsoldCount, 'vendió', 'vendieron')} ni una unidad.`,
    );
  }
  return lines.join('\n');
}

export interface MenuOption {
  value: string;
  label: string;
}

/**
 * Lo que el agente puede hacer HOY por ese negocio.
 *
 * Se construye por vertical y solo con capacidades implementadas: prometer
 * "consultar mesas" en un menú y después no saber responderlo es peor que no
 * ofrecerlo. Restaurante y barbería no tienen capacidades en `AssistantService`,
 * así que su menú lo dice en vez de inventar opciones.
 */
export function menuFor(vertical: string | null | undefined): MenuOption[] {
  if ((vertical ?? '').toLowerCase() === 'retail') {
    return [
      { value: 'sales_summary', label: 'Ventas' },
      { value: 'pending_payment', label: 'Saldos por cobrar' },
      { value: 'low_stock', label: 'Qué se está acabando' },
      { value: 'pending_delivery', label: 'Pedidos por entregar' },
      { value: 'top_products', label: 'Lo más vendido' },
      { value: 'human_handoff', label: 'Hablar con el equipo de Lynko' },
    ];
  }
  return [{ value: 'human_handoff', label: 'Hablar con el equipo de Lynko' }];
}

export function renderMenu(options: MenuOption[]): string {
  return options
    .map((option, index) => `${index + 1}. ${option.label}`)
    .join('\n');
}

export function capabilityUnavailableText(
  businessName: string,
  vertical: string | null | undefined,
): string {
  const code = (vertical ?? '').toLowerCase();
  const kind =
    code === 'barber'
      ? ' de barbería'
      : code === 'restaurant'
        ? ' de restaurante'
        : '';
  return [
    `Por aquí todavía no puedo consultar las cifras${kind} de ${businessName}.`,
    'Están completas en la app. Si necesitas algo del equipo de Lynko, escríbeme y te paso con alguien.',
  ].join(' ');
}

export function intentNeedsRetail(intent: AgentIntent): boolean {
  return [
    'sales_summary',
    'business_report',
    'pending_payment',
    'pending_delivery',
    'low_stock',
    'inventory_value',
    'top_products',
  ].includes(intent);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
