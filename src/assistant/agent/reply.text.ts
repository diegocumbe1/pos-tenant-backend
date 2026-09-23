import { formatCOP } from '../../common/date.util';
import {
  ExpensesAnswer,
  InventoryStatusAnswer,
  PendingDeliveryAnswer,
  PendingPaymentAnswer,
  PendingPurchaseAnswer,
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

/**
 * "¿Cuántos productos he vendido?" — UNIDADES, no pesos.
 *
 * Sale de la misma lectura que `salesText` y por eso nombra también el dinero:
 * quien pregunta cuántas unidades movió casi siempre quiere saber a continuación
 * cuánto fue eso, y ahorrarle el segundo mensaje es la mitad del valor.
 */
export function unitsSoldText(sales: SalesAnswer): string {
  const label = periodLabel(sales.period);
  if (!sales.unitsSold) {
    return `${capitalize(label)} ${sales.business.name} no ha vendido ninguna unidad.`;
  }
  return [
    `${capitalize(label)} ${sales.business.name} vendió *${sales.unitsSold}* ${plural(sales.unitsSold, 'unidad', 'unidades')} en ${sales.salesCount} ${plural(sales.salesCount, 'venta', 'ventas')}.`,
    `Eso son ${formatCOP(sales.revenueCOP)} en mercancía.`,
  ].join('\n');
}

export function expensesText(expenses: ExpensesAnswer): string {
  const label = periodLabel(expenses.period);
  if (!expenses.totalCOP) {
    return `${capitalize(label)} ${expenses.business.name} no registra gastos.`;
  }
  const lines = [
    `${capitalize(label)} ${expenses.business.name} lleva *${formatCOP(expenses.totalCOP)}* en ${expenses.count} ${plural(expenses.count, 'gasto', 'gastos')}.`,
  ];
  for (const row of expenses.byCategory.slice(0, 5)) {
    lines.push(`• ${row.category}: ${formatCOP(row.amountCOP)}`);
  }
  if (expenses.byCategory.length > 5) {
    lines.push(`… y ${expenses.byCategory.length - 5} categorías más.`);
  }
  return lines.join('\n');
}

/**
 * Lo pedido al proveedor que todavía no llega.
 *
 * Se distingue explícitamente de lo que falta ENTREGAR: son dos listas
 * distintas y la frase tiene que dejar claro cuál se está leyendo, porque la
 * pregunta ("¿qué pedidos tengo pendientes?") suena igual para las dos.
 */
export function pendingPurchaseText(purchase: PendingPurchaseAnswer): string {
  if (!purchase.openCount) {
    return `${purchase.business.name} no tiene pedidos pendientes por recibir del proveedor.`;
  }
  const lines = [
    `${purchase.business.name} tiene *${purchase.openCount}* ${plural(purchase.openCount, 'pedido', 'pedidos')} sin recibir, por unos ${formatCOP(purchase.estimatedOpenCostCOP)}.`,
    // El desglose importa: "sin pedir" depende de uno, "en camino" del
    // proveedor, y son dos acciones distintas.
    `${purchase.pendingCount} sin pedir · ${purchase.orderedCount} en camino · ${purchase.partiallyReceivedCount} a medias`,
  ];
  for (const item of purchase.items.slice(0, 5)) {
    const supplier = item.supplier ? ` (${item.supplier})` : '';
    lines.push(
      `• ${item.isUrgent ? '🔴 ' : ''}${item.name} — ${item.quantity}${supplier}`,
    );
  }
  if (purchase.items.length > 5) {
    lines.push(`… y ${purchase.items.length - 5} más.`);
  }
  return lines.join('\n');
}

export function customersText(ranking: SalesRankingAnswer): string {
  const label = periodLabel(ranking.period);
  if (!ranking.customers.length) {
    return `No hay compras de clientes identificados ${label} en ${ranking.business.name}.`;
  }
  const lines = [`Quién más compró ${label} en ${ranking.business.name}:`];
  ranking.customers.slice(0, 5).forEach((customer, index) => {
    lines.push(
      `${index + 1}. ${customer.name} — ${formatCOP(customer.totalCOP)} en ${customer.salesCount} ${plural(customer.salesCount, 'compra', 'compras')}`,
    );
  });
  if (ranking.counterSales > 0) {
    lines.push(
      `${ranking.counterSales} ${plural(ranking.counterSales, 'venta', 'ventas')} de mostrador sin cliente asociado no ${plural(ranking.counterSales, 'entra', 'entran')} al ranking.`,
    );
  }
  return lines.join('\n');
}

/** Lo que está quieto: la pregunta que de verdad hace quien dice "lo menos vendido". */
export function worstProductsText(ranking: SalesRankingAnswer): string {
  const label = periodLabel(ranking.period);
  if (!ranking.unsoldCount && !ranking.unsoldProducts.length) {
    return `Todo el catálogo de ${ranking.business.name} vendió algo ${label}.`;
  }
  const lines = [
    `${ranking.unsoldCount} ${plural(ranking.unsoldCount, 'producto', 'productos')} no ${plural(ranking.unsoldCount, 'vendió', 'vendieron')} ni una unidad ${label} en ${ranking.business.name}.`,
  ];
  // De más a menos stock detenido: más unidades quietas es más plata dormida, y
  // es por donde hay que empezar.
  for (const product of ranking.unsoldProducts.slice(0, 5)) {
    lines.push(`• ${product.name} — ${product.stock} en stock`);
  }
  return lines.join('\n');
}

/** Solo lo que YA está en cero: distinto de lo que se está acabando. */
export function outOfStockText(inventory: InventoryStatusAnswer): string {
  const out = inventory.lowStock.filter((item) => item.stock <= 0);
  if (!out.length) {
    return `Nada agotado en ${inventory.business.name}.`;
  }
  const lines = [
    `${out.length} ${plural(out.length, 'producto', 'productos')} en cero en ${inventory.business.name}:`,
  ];
  for (const item of out.slice(0, 8)) lines.push(`• ${item.name}`);
  if (out.length > 8) lines.push(`… y ${out.length - 8} más.`);
  return lines.join('\n');
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
 * Ya NO se muestra como lista numerada —ver `capabilityHint`—, pero se sigue
 * guardando en el contexto para poder resolver un "2" de quien viene de una
 * conversación anterior donde sí vio números.
 *
 * Se construye por vertical y solo con capacidades implementadas: prometer
 * "consultar mesas" y después no saber responderlo es peor que no ofrecerlo.
 * Restaurante y barbería no tienen capacidades en `AssistantService`.
 */
export function menuFor(vertical: string | null | undefined): MenuOption[] {
  if ((vertical ?? '').toLowerCase() === 'retail') {
    return [
      { value: 'sales_summary', label: 'Ventas' },
      { value: 'expenses_summary', label: 'Gastos' },
      { value: 'pending_payment', label: 'Saldos por cobrar' },
      { value: 'low_stock', label: 'Qué se está acabando' },
      { value: 'pending_delivery', label: 'Pedidos por entregar' },
      { value: 'pending_purchase', label: 'Pedidos por recibir' },
      { value: 'top_products', label: 'Lo más vendido' },
      { value: 'top_customers', label: 'Quién compra más' },
      { value: 'business_report', label: 'Reporte general' },
      { value: 'human_handoff', label: 'Hablar con un asesor de Lynko' },
    ];
  }
  return [{ value: 'human_handoff', label: 'Hablar con un asesor de Lynko' }];
}

/**
 * Lo que se puede preguntar, dicho como lo diría una persona.
 *
 * No es la lista de `menuFor` con comas: las etiquetas de un menú ("Saldos por
 * cobrar") no son lo que alguien escribe. Estas frases son ejemplos de
 * preguntas reales, que además le enseñan al usuario que puede escribir libre.
 */
export function capabilityHint(vertical: string | null | undefined): string {
  if ((vertical ?? '').toLowerCase() === 'retail') {
    // Se nombran cuatro, no las diez: una lista larga se lee como un menú y lo
    // que se busca es que la siguiente frase sea una pregunta suya. Las cuatro
    // elegidas cubren las cuatro áreas —entra, sale, mercancía, clientes— para
    // que se entienda el alcance sin enumerarlo.
    return 'Pregúntame lo que necesites: cuánto has vendido, en qué se te va la plata, qué se está acabando o quién te debe. Puedes pedirme un período: "de los últimos 15 días", "el mes pasado", "en marzo".';
  }
  return 'Cuéntame qué necesitas y, si no lo sé hacer todavía, te paso con un asesor.';
}

/**
 * Lo que se responde cuando piden un total sin decir de cuándo.
 *
 * Es la diferencia entre titubear y preguntar bien: "cuánto llevo en ventas
 * totales" no tiene una respuesta correcta sin período, y asumir hoy en
 * silencio es dar una cifra exacta a una pregunta que nadie hizo.
 */
export const ASK_PERIOD =
  '¿De qué período? Dime "hoy", "esta semana", "este mes", "el mes pasado" o algo como "los últimos 15 días".';

/** Cuando ya se ofreció ayuda hace un momento, repetir el discurso sobra. */
export const SHORT_HINT = '¿Qué quieres saber?';

/**
 * La pregunta de cuál negocio, en prosa.
 *
 * Hasta seis se nombran; más arriba de eso, leer una lista en un chat es peor
 * que escribir el nombre. Los números se siguen aceptando aunque no se vean.
 */
export function businessQuestion(names: string[], total: number): string {
  if (total > names.length) {
    return `Tienes ${total} negocios. Escríbeme el nombre del que quieras consultar.`;
  }
  // Con uno solo no hay nada que elegir. Se llega aquí cuando alguien nombró un
  // negocio que no es suyo, y "¿de cuál negocio? Tienes X" suena a pregunta con
  // una sola respuesta posible: se afirma en vez de preguntar.
  if (names.length === 1) {
    return `El negocio que tienes asociado es ${names[0]}.`;
  }
  if (names.length === 2) {
    return `¿De cuál negocio: ${names[0]} o ${names[1]}?`;
  }
  const last = names[names.length - 1];
  return `¿De cuál negocio? Tienes ${names.slice(0, -1).join(', ')} y ${last}.`;
}

/** Cuántos negocios se nombran en prosa antes de pedir el nombre escrito. */
export const MAX_SPOKEN_BUSINESSES = 6;

/**
 * La invitación a un desconocido, sin menú.
 *
 * Las tres salidas reales (conocer Lynko, ver una demo, soporte) van dichas en
 * una frase. Quien responda "demo", "quiero verlo" o "ya soy cliente" cae en su
 * intent igual que antes.
 */
export function strangerInvite(
  firstName: string | null,
  greet: boolean,
): string {
  const hello = greet
    ? `¡Hola${firstName ? `, ${firstName}` : ''}! 👋 Soy el asistente de Lynko.\n`
    : '';
  return `${hello}¿Quieres saber qué hace Lynko, que te muestren una demostración, o ya eres cliente y necesitas ayuda?`;
}

/**
 * Lo que se responde a "¿eres un bot?", y lo que define el tono de todo esto.
 *
 * El agente NUNCA se hace pasar por una persona. No es un escrúpulo abstracto:
 * quien cree que habló con alguien del equipo y después descubre que no,
 * desconfía de todo lo que le dijeron, incluidas las cifras. Presentarse como
 * asistente desde el primer mensaje cuesta cero y evita eso entero.
 */
export const IDENTITY_DISCLOSURE =
  'Soy el asistente automático de Lynko, no una persona. Puedo consultarte cifras de tu negocio al instante, y cuando algo se me sale de las manos te paso con un asesor.';

/**
 * El escalamiento, con la espera dicha de frente.
 *
 * `timing` sale de `handoffTiming()`: dentro del horario dice "en un momento",
 * fuera dice cuándo. Prometer que "alguien te escribe ya" un domingo a las
 * once de la noche es la forma más barata de quedar mal.
 */
export function handoffText(reason: string, timing: string): string {
  return `${reason} Te comunico con un asesor más experto para atender tu caso. ${timing}`;
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
    'Están completas en la app. Si necesitas algo más, dime y te paso con un asesor.',
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
