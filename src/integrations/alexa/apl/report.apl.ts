import { interfaces } from 'ask-sdk-model';
import { formatCOP } from '../../../common/date.util';
import {
  BusinessReportAnswer,
  PendingPaymentAnswer,
  ReportPeriod,
  SalesAnswer,
} from '../../../assistant/assistant.types';
import { periodLabel } from '../../../assistant/report-period';

type RenderDocument = interfaces.alexa.presentation.apl.RenderDocumentDirective;

/** Cuántas filas caben bajo el hero en los 480dp de alto de una Show 5. */
const MAX_ROWS = 4;

const BACKGROUND = '#0E0E12';
const BORDER = '#2A2C35';
const WHITE = '#FFFFFF';
const MUTED = '#8B8D98';
const GREEN = '#34D399';
const AMBER = '#FBBF24';
const RED = '#F87171';

/**
 * El panel: encabezado, una cifra grande con barra de acento, y filas de
 * etiqueta y valor.
 *
 * Todo el documento se arma con los valores ya escritos dentro. Sin
 * `datasources`, sin `${}` y sin `import`: en el dispositivo, un binding que no
 * resuelve no da error —pinta el fondo y deja el texto vacío—, y esa pantalla
 * negra costó cuatro pruebas en el Echo Show. Acá, si algo no se ve es porque
 * no se puso.
 */
interface Panel {
  business: string;
  period: string;
  /** "VENTAS", "POR COBRAR": qué es la cifra grande. */
  heroLabel: string;
  hero: string;
  heroAccent: string;
  sub: string;
  rows: Row[];
}

interface Row {
  label: string;
  value: string;
  /** El color dice si hay que hacer algo: ámbar debe, rojo urge. */
  accent?: string;
}

function text(
  content: string,
  size: string,
  color: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'Text',
    text: content,
    color,
    fontSize: size,
    maxLines: 1,
    ...extra,
  };
}

/** Etiqueta a la izquierda, valor a la derecha: la lista se lee en columna. */
function row(r: Row): Record<string, unknown> {
  return {
    type: 'Container',
    direction: 'row',
    width: '100%',
    paddingBottom: '6dp',
    items: [
      text(r.label, '26dp', MUTED, { grow: 1, shrink: 1 }),
      text(r.value, '26dp', r.accent ?? WHITE, { fontWeight: '600' }),
    ],
  };
}

function panel(token: string, p: Panel): RenderDocument {
  return {
    type: 'Alexa.Presentation.APL.RenderDocument',
    token,
    document: {
      type: 'APL',
      version: '1.6',
      mainTemplate: {
        items: [
          {
            // Frame y no Container: `backgroundColor` solo existe en Frame.
            type: 'Frame',
            width: '100vw',
            height: '100vh',
            backgroundColor: BACKGROUND,
            item: {
              type: 'Container',
              width: '100%',
              height: '100%',
              paddingLeft: '26dp',
              paddingRight: '26dp',
              paddingTop: '16dp',
              paddingBottom: '16dp',
              items: [
                // Encabezado: negocio a la izquierda, período a la derecha.
                {
                  type: 'Container',
                  direction: 'row',
                  width: '100%',
                  alignItems: 'baseline',
                  items: [
                    text(p.business, '22dp', WHITE, {
                      fontWeight: '700',
                      grow: 1,
                      shrink: 1,
                    }),
                    text(p.period, '20dp', MUTED),
                  ],
                },
                {
                  type: 'Frame',
                  width: '100%',
                  height: '2dp',
                  backgroundColor: BORDER,
                },
                // La cifra, con una franja de color que la separa del resto.
                {
                  type: 'Container',
                  direction: 'row',
                  width: '100%',
                  paddingTop: '12dp',
                  paddingBottom: '12dp',
                  items: [
                    {
                      type: 'Frame',
                      width: '6dp',
                      height: '132dp',
                      backgroundColor: p.heroAccent,
                      borderRadius: '3dp',
                    },
                    {
                      type: 'Container',
                      grow: 1,
                      shrink: 1,
                      paddingLeft: '14dp',
                      items: [
                        text(p.heroLabel, '18dp', MUTED, { fontWeight: '600' }),
                        text(p.hero, '76dp', p.heroAccent, {
                          fontWeight: '700',
                        }),
                        text(p.sub, '20dp', MUTED),
                      ],
                    },
                  ],
                },
                {
                  type: 'Container',
                  width: '100%',
                  items: p.rows.slice(0, MAX_ROWS).map(row),
                },
              ],
            },
          },
        ],
      },
    },
  };
}

/**
 * En pantalla el período se lee como título, no como frase hablada: la voz dice
 * "en lo que va del mes" y el encabezado dice "Este mes".
 */
const NAMED_TITLES: Partial<Record<ReportPeriod, string>> = {
  day: 'Hoy',
  yesterday: 'Ayer',
  week: 'Esta semana',
  lastWeek: 'Semana pasada',
  month: 'Este mes',
  lastMonth: 'Mes pasado',
  year: 'Este año',
};

/**
 * Los períodos abiertos —"los últimos 15 días", "marzo"— no caben en una tabla
 * fija, así que se derivan de la frase hablada y se capitalizan. Es preferible
 * a un `Record` exhaustivo: con `last:${number}` en el tipo, ese Record no se
 * puede escribir y un default silencioso pondría "Hoy" sobre cifras de marzo.
 */
function periodTitle(period: ReportPeriod): string {
  const named = NAMED_TITLES[period];
  if (named) return named;
  const spoken = periodLabel(period).replace(/^en /, '');
  return spoken.charAt(0).toUpperCase() + spoken.slice(1);
}

/** "Cómo vamos": la venta manda, y debajo lo accionable. */
export function reportDocument(report: BusinessReportAnswer): RenderDocument {
  const { sales, debt, inventory } = report;

  return panel('lynko-report', {
    business: report.business.name,
    period: periodTitle(report.period),
    heroLabel: 'VENTAS',
    hero: formatCOP(sales.revenueCOP),
    heroAccent: sales.revenueCOP > 0 ? GREEN : MUTED,
    sub: `${sales.salesCount} ${plural(sales.salesCount, 'venta', 'ventas')} · Margen ${sales.marginPct}%`,
    rows: [
      {
        label: 'Por cobrar',
        value: formatCOP(debt.totalCOP),
        accent: debt.totalCOP > 0 ? AMBER : MUTED,
      },
      {
        label: 'Stock bajo',
        value: `${inventory.lowStockCount} · ${inventory.outOfStockCount} agotados`,
        // Rojo solo si hay algo en cero: lo bajo se repone, lo agotado ya
        // está costando ventas.
        accent:
          inventory.outOfStockCount > 0
            ? RED
            : inventory.lowStockCount > 0
              ? AMBER
              : MUTED,
      },
      {
        label: 'Por entregar',
        value: formatCOP(report.delivery.totalCOP),
        accent: report.delivery.totalCOP > 0 ? WHITE : MUTED,
      },
      { label: 'Ticket promedio', value: formatCOP(sales.averageTicketCOP) },
    ],
  });
}

/** "Quién me debe": el total manda y los nombres son el detalle que importa. */
export function debtDocument(answer: PendingPaymentAnswer): RenderDocument {
  const rows: Row[] = answer.totalCOP
    ? [
        ...answer.customers.map((c) => ({
          label: c.name,
          value: formatCOP(c.amountCOP),
          accent: AMBER,
        })),
        ...(answer.unidentified.amountCOP
          ? [
              {
                label: 'Sin cliente',
                value: formatCOP(answer.unidentified.amountCOP),
                accent: RED,
              },
            ]
          : []),
      ]
    : [{ label: 'Sin cartera pendiente', value: '', accent: MUTED }];

  return panel('lynko-debt', {
    business: answer.business.name,
    // La cartera no es de un período: es el saldo de hoy, venga de donde venga.
    period: 'Cartera',
    heroLabel: 'POR COBRAR',
    hero: formatCOP(answer.totalCOP),
    heroAccent: answer.totalCOP > 0 ? AMBER : GREEN,
    sub: `${answer.salesCount} ${plural(answer.salesCount, 'venta', 'ventas')} sin cobrar`,
    rows,
  });
}

/** "Cuánto vendí": las cifras del período, sin la cartera. */
export function salesDocument(answer: SalesAnswer): RenderDocument {
  return panel('lynko-sales', {
    business: answer.business.name,
    period: periodTitle(answer.period),
    heroLabel: 'VENTAS',
    hero: formatCOP(answer.revenueCOP),
    heroAccent: answer.revenueCOP > 0 ? GREEN : MUTED,
    sub: `${answer.salesCount} ${plural(answer.salesCount, 'venta', 'ventas')} · ${answer.unitsSold} und`,
    rows: [
      { label: 'Ticket promedio', value: formatCOP(answer.averageTicketCOP) },
      { label: 'Margen', value: `${answer.marginPct}%`, accent: GREEN },
      // Lo fiado del período, no la cartera total: son cifras distintas.
      ...(answer.creditedCOP
        ? [
            {
              label: 'Fiado',
              value: formatCOP(answer.creditedCOP),
              accent: AMBER,
            },
          ]
        : []),
      // El flete no está dentro de las ventas: nombrarlo aparte evita que
      // alguien sume dos cifras que ya no se suman.
      ...(answer.shippingCOP
        ? [{ label: 'Flete aparte', value: formatCOP(answer.shippingCOP) }]
        : []),
    ],
  });
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
