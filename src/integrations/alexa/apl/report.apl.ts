import { interfaces } from 'ask-sdk-model';
import { formatCOP } from '../../../common/date.util';
import {
  BusinessReportAnswer,
  ReportPeriod,
} from '../../../assistant/assistant.types';

type RenderDocument = interfaces.alexa.presentation.apl.RenderDocumentDirective;

/** Cuántos deudores caben en pantalla sin que las barras se vuelvan ilegibles. */
const MAX_BARS = 4;

/**
 * En pantalla el período se lee como título, no como frase hablada: la voz dice
 * "en lo que va del mes" y el encabezado dice "Este mes".
 */
const PERIOD_TITLE: Record<ReportPeriod, string> = {
  day: 'Hoy',
  yesterday: 'Ayer',
  week: 'Esta semana',
  month: 'Este mes',
};

/**
 * El reporte en pantalla, para dispositivos con APL.
 *
 * Los valores llegan ya formateados desde acá: el documento no hace cuentas ni
 * formatea moneda porque el data-binding de APL no tiene `Intl`, y un `48521`
 * sin separadores es justo lo que hace ver barato un reporte.
 */
export function reportDocument(report: BusinessReportAnswer): RenderDocument {
  const { sales, debt, inventory } = report;

  return {
    type: 'Alexa.Presentation.APL.RenderDocument',
    token: 'lynko-report',
    document: DOCUMENT,
    datasources: {
      payload: {
        business: report.business.name,
        period: PERIOD_TITLE[report.period],
        kpis: [
          kpi('Ventas', sales.revenueCOP, {
            sub: `${sales.salesCount} ${plural(sales.salesCount, 'venta', 'ventas')}`,
            accent: '@accentGreen',
          }),
          {
            label: 'Margen',
            value: `${sales.marginPct}%`,
            compact: `${sales.marginPct}%`,
            sub: `${sales.unitsSold} und`,
            accent: '@accentGreen',
          },
          kpi('Por cobrar', debt.totalCOP, {
            sub: `${debt.salesCount} ${plural(debt.salesCount, 'venta', 'ventas')}`,
            accent: debt.totalCOP > 0 ? '@accentAmber' : '@textMuted',
          }),
          {
            label: 'Stock bajo',
            value: `${inventory.lowStockCount}`,
            compact: `${inventory.lowStockCount}`,
            sub: `${inventory.outOfStockCount} agotados`,
            accent:
              inventory.outOfStockCount > 0
                ? '@accentRed'
                : inventory.lowStockCount > 0
                  ? '@accentAmber'
                  : '@textMuted',
          },
        ],
        bars: debtBars(report),
        // Sin cartera no se deja el bloque vacío: se dice, que es información.
        emptyBars: debt.totalCOP > 0 ? '' : 'Sin cartera pendiente',
        ticket: `Ticket promedio ${formatCOP(sales.averageTicketCOP)}`,
      },
    },
  };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function kpi(
  label: string,
  amount: number,
  rest: { sub: string; accent: string },
) {
  return {
    label,
    value: formatCOP(amount),
    compact: compactCOP(amount),
    ...rest,
  };
}

/**
 * '$ 1,16 M' para pantallas de cinco pulgadas.
 *
 * En una Echo Show 5 el tile mide unos 210dp: '$ 1.164.500' se corta a media
 * cifra, y un número cortado miente. La voz sí dice el monto exacto, así que
 * abreviar en pantalla no pierde nada.
 */
function compactCOP(amount: number): string {
  if (Math.abs(amount) < 1_000_000) return formatCOP(amount);
  const millions = (amount / 1_000_000).toFixed(2).replace('.', ',');
  return `$ ${millions} M`;
}

/**
 * Las barras son proporcionales al mayor saldo, no al total de la cartera: con
 * un deudor grande y tres chicos, contra el total las tres últimas barras
 * quedarían en un hilo invisible.
 */
function debtBars(report: BusinessReportAnswer) {
  const { customers, unidentified } = report.debt;
  const rows = [
    ...customers.map((c) => ({ name: c.name, amount: c.amountCOP })),
    ...(unidentified.amountCOP > 0
      ? [{ name: 'Sin cliente', amount: unidentified.amountCOP }]
      : []),
  ]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, MAX_BARS);

  const max = rows[0]?.amount ?? 0;
  return rows.map((row) => ({
    name: row.name,
    amount: formatCOP(row.amount),
    // Un mínimo de 6%: una barra de 0.4% no se ve y parece un error de render.
    width: `${max > 0 ? Math.max(6, Math.round((row.amount / max) * 100)) : 0}%`,
  }));
}

/** El tile de KPI, parametrizado para no repetirlo en los dos layouts. */
const KPI_TILE = {
  type: 'Frame',
  grow: 1,
  shrink: 1,
  backgroundColor: '@surface',
  borderColor: '@border',
  borderWidth: '1dp',
  borderRadius: '14dp',
  item: {
    type: 'Container',
    paddingLeft: '@tilePad',
    paddingRight: '@tilePad',
    paddingTop: '@tilePad',
    paddingBottom: '@tilePad',
    items: [
      {
        type: 'Text',
        text: '${tile.label}',
        color: '@textMuted',
        fontSize: '@kpiLabelSize',
        fontWeight: '600',
        maxLines: 1,
      },
      {
        type: 'Text',
        // En pantalla angosta el monto va abreviado; cortado no sirve.
        text: '${@compactValues ? tile.compact : tile.value}',
        color: '${tile.accent}',
        fontSize: '@kpiValueSize',
        fontWeight: '700',
        maxLines: 1,
      },
      {
        type: 'Text',
        text: '${tile.sub}',
        color: '@textMuted',
        fontSize: '@kpiSubSize',
        maxLines: 1,
      },
    ],
  },
};

/** Una fila de tiles: `from` e `in` son índices de `payload.kpis`. */
const kpiRow = (indices: number[]) => ({
  type: 'Container',
  direction: 'row',
  width: '100%',
  paddingTop: '@gap',
  items: indices.map((i, position) => ({
    ...KPI_TILE,
    marginRight: position < indices.length - 1 ? '@gap' : '0dp',
    bind: [{ name: 'tile', value: `\${payload.kpis[${i}]}` }],
  })),
});

/**
 * Layout único para los dos destinos: Echo Show 5 (960x480, apaisada) y la app
 * móvil (vertical y angosta).
 *
 * En apaisada los cuatro KPIs van en una fila; en vertical van dos por fila,
 * porque cuatro tiles en 400dp de ancho dejan cada valor en tres caracteres.
 * Los tamaños salen de `resources`, con una variante para pantallas bajas: con
 * los tamaños de una Show 10 el bloque de deudores queda fuera de la Show 5.
 */
const DOCUMENT = {
  type: 'APL',
  version: '1.6',
  theme: 'dark',
  resources: [
    {
      description: 'Paleta Lynko',
      colors: {
        background: '#0E0E12',
        surface: '#1A1B21',
        border: '#2A2C35',
        textPrimary: '#FFFFFF',
        textMuted: '#8B8D98',
        accentGreen: '#34D399',
        accentAmber: '#FBBF24',
        accentRed: '#F87171',
      },
    },
    {
      description: 'Pantalla amplia: Show 8, 10, 15',
      dimensions: {
        kpiValueSize: '38dp',
        kpiLabelSize: '16dp',
        kpiSubSize: '15dp',
        titleSize: '32dp',
        rowSize: '20dp',
        gap: '12dp',
        tilePad: '14dp',
        pad: '26dp',
        barHeight: '8dp',
      },
      booleans: { compactValues: false },
    },
    {
      // 480dp de alto es la Echo Show 5; también entra la app móvil pequeña.
      description: 'Pantalla baja o angosta: Echo Show 5, móvil',
      when: '${viewport.height < 600 || viewport.width < 600}',
      dimensions: {
        kpiValueSize: '26dp',
        kpiLabelSize: '12dp',
        kpiSubSize: '11dp',
        titleSize: '22dp',
        rowSize: '15dp',
        gap: '8dp',
        tilePad: '9dp',
        pad: '16dp',
        barHeight: '6dp',
      },
      booleans: { compactValues: true },
    },
  ],
  mainTemplate: {
    parameters: ['payload'],
    items: [
      {
        type: 'Container',
        width: '100vw',
        height: '100vh',
        backgroundColor: '@background',
        paddingLeft: '@pad',
        paddingRight: '@pad',
        paddingTop: '@pad',
        paddingBottom: '@pad',
        items: [
          // Encabezado
          {
            type: 'Container',
            direction: 'row',
            alignItems: 'baseline',
            width: '100%',
            items: [
              {
                type: 'Text',
                text: '${payload.business}',
                color: '@textPrimary',
                fontSize: '@titleSize',
                fontWeight: '700',
                maxLines: 1,
                grow: 1,
                shrink: 1,
              },
              {
                type: 'Text',
                text: '${payload.period}',
                color: '@textMuted',
                fontSize: '@kpiLabelSize',
                fontWeight: '500',
              },
            ],
          },
          // KPIs: una fila de cuatro en apaisada...
          {
            type: 'Container',
            when: '${viewport.width >= viewport.height}',
            width: '100%',
            items: [kpiRow([0, 1, 2, 3])],
          },
          // ...o dos filas de dos en vertical.
          {
            type: 'Container',
            when: '${viewport.width < viewport.height}',
            width: '100%',
            items: [kpiRow([0, 1]), kpiRow([2, 3])],
          },
          // Cartera: barras proporcionales
          {
            type: 'Container',
            width: '100%',
            grow: 1,
            shrink: 1,
            paddingTop: '@gap',
            items: [
              {
                type: 'Text',
                text: 'Quién me debe',
                color: '@textMuted',
                fontSize: '@kpiLabelSize',
                fontWeight: '600',
                paddingBottom: '4dp',
              },
              {
                type: 'Text',
                when: '${payload.emptyBars != ""}',
                text: '${payload.emptyBars}',
                color: '@textMuted',
                fontSize: '@rowSize',
              },
              {
                // Sequence y no Container: en la Show 5 el cuarto deudor queda
                // abajo del borde y sin scroll no habría cómo verlo.
                type: 'Sequence',
                when: '${payload.emptyBars == ""}',
                width: '100%',
                grow: 1,
                shrink: 1,
                data: '${payload.bars}',
                items: [
                  {
                    type: 'Container',
                    width: '100%',
                    paddingBottom: '7dp',
                    items: [
                      {
                        type: 'Container',
                        direction: 'row',
                        width: '100%',
                        items: [
                          {
                            type: 'Text',
                            text: '${data.name}',
                            color: '@textPrimary',
                            fontSize: '@rowSize',
                            maxLines: 1,
                            grow: 1,
                            shrink: 1,
                          },
                          {
                            type: 'Text',
                            text: '${data.amount}',
                            color: '@accentAmber',
                            fontSize: '@rowSize',
                            fontWeight: '600',
                          },
                        ],
                      },
                      {
                        type: 'Frame',
                        width: '100%',
                        height: '@barHeight',
                        backgroundColor: '@border',
                        borderRadius: '4dp',
                        item: {
                          type: 'Frame',
                          width: '${data.width}',
                          height: '@barHeight',
                          backgroundColor: '@accentAmber',
                          borderRadius: '4dp',
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: 'Text',
            text: '${payload.ticket}',
            color: '@textMuted',
            fontSize: '@kpiSubSize',
            textAlign: 'right',
            width: '100%',
          },
        ],
      },
    ],
  },
};
