import { interfaces } from 'ask-sdk-model';
import { formatCOP } from '../../../common/date.util';
import {
  BusinessReportAnswer,
  DebtFigures,
  PendingPaymentAnswer,
  ReportPeriod,
  SalesAnswer,
} from '../../../assistant/assistant.types';

type RenderDocument = interfaces.alexa.presentation.apl.RenderDocumentDirective;

/** Cuántas barras caben en pantalla sin volverse ilegibles. */
const MAX_BARS = 3;

interface Cell {
  label: string;
  value: string;
  /** Monto abreviado, para los tiles chicos donde el largo no cabe. */
  compact: string;
  sub: string;
  accent: string;
}

/**
 * Lo que el documento sabe pintar.
 *
 * Una sola cifra manda —`hero`— y el resto la acompaña. La Echo Show 5 se mira
 * desde el otro lado de la cocina, no a treinta centímetros: cuatro cifras del
 * mismo tamaño ahí no son un tablero, son una pantalla que nadie lee.
 */
interface Panel {
  business: string;
  period: string;
  hero: Cell;
  /** Dos se ven siempre; la tercera solo donde sobra pantalla. */
  tiles: Cell[];
  /** Vacío esconde el bloque entero; no deja un título sobre la nada. */
  barsTitle: string;
  bars: { name: string; amount: string; width: string }[];
  emptyBars: string;
}

function panel(token: string, payload: Panel): RenderDocument {
  return {
    type: 'Alexa.Presentation.APL.RenderDocument',
    token,
    document: DOCUMENT,
    datasources: { payload },
  };
}

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
 * "Cómo vamos": la venta manda, y debajo lo accionable.
 *
 * Por cobrar y stock bajo van antes que el margen porque son las dos que
 * mueven a hacer algo hoy; el margen es interesante, no urgente, y por eso
 * queda en la tercera casilla, la que solo aparece en pantallas grandes.
 */
export function reportDocument(report: BusinessReportAnswer): RenderDocument {
  const { sales, debt, inventory } = report;

  return panel('lynko-report', {
    business: report.business.name,
    period: PERIOD_TITLE[report.period],
    hero: money('Ventas', sales.revenueCOP, {
      sub: `${sales.salesCount} ${plural(sales.salesCount, 'venta', 'ventas')}`,
      accent: '@accentGreen',
    }),
    tiles: [
      money('Por cobrar', debt.totalCOP, {
        sub: `${debt.salesCount} ${plural(debt.salesCount, 'venta', 'ventas')}`,
        accent: debt.totalCOP > 0 ? '@accentAmber' : '@textMuted',
      }),
      plain('Stock bajo', `${inventory.lowStockCount}`, {
        sub: `${inventory.outOfStockCount} agotados`,
        accent:
          inventory.outOfStockCount > 0
            ? '@accentRed'
            : inventory.lowStockCount > 0
              ? '@accentAmber'
              : '@textMuted',
      }),
      plain('Margen', `${sales.marginPct}%`, {
        sub: `${sales.unitsSold} und`,
        accent: '@accentGreen',
      }),
    ],
    barsTitle: 'Quién me debe',
    bars: debtBars(debt),
    // Sin cartera no se deja el bloque vacío: se dice, que es información.
    emptyBars: debt.totalCOP > 0 ? '' : 'Sin cartera pendiente',
  });
}

/** "Quién me debe": el total manda y los nombres son el detalle que importa. */
export function debtDocument(answer: PendingPaymentAnswer): RenderDocument {
  const top = answer.customers[0];
  return panel('lynko-debt', {
    business: answer.business.name,
    // La cartera no es de un período: es el saldo de hoy, venga de donde venga.
    period: 'Cartera',
    hero: money('Por cobrar', answer.totalCOP, {
      sub: `${answer.salesCount} ${plural(answer.salesCount, 'venta', 'ventas')}`,
      accent: answer.totalCOP > 0 ? '@accentAmber' : '@textMuted',
    }),
    tiles: [
      plain('Clientes', `${answer.customers.length}`, {
        sub: 'con saldo',
        accent: '@textPrimary',
      }),
      money('El mayor', top?.amountCOP ?? 0, {
        sub: top?.name ?? 'sin deudores',
        accent: '@accentAmber',
      }),
      money('Sin cliente', answer.unidentified.amountCOP, {
        sub: `${answer.unidentified.salesCount} ${plural(answer.unidentified.salesCount, 'venta', 'ventas')}`,
        accent: answer.unidentified.amountCOP > 0 ? '@accentRed' : '@textMuted',
      }),
    ],
    barsTitle: 'Saldo por cliente',
    bars: debtBars(answer),
    emptyBars: answer.totalCOP > 0 ? '' : 'Sin cartera pendiente',
  });
}

/** "Cuánto vendí": sin barras, porque no hay nada que comparar entre sí. */
export function salesDocument(answer: SalesAnswer): RenderDocument {
  return panel('lynko-sales', {
    business: answer.business.name,
    period: PERIOD_TITLE[answer.period],
    hero: money('Ventas', answer.revenueCOP, {
      sub: `${answer.salesCount} ${plural(answer.salesCount, 'venta', 'ventas')}`,
      accent: '@accentGreen',
    }),
    tiles: [
      money('Ticket promedio', answer.averageTicketCOP, {
        sub: `${answer.unitsSold} und`,
        accent: '@textPrimary',
      }),
      plain('Margen', `${answer.marginPct}%`, {
        sub: 'del período',
        accent: '@accentGreen',
      }),
      // Lo fiado del período, no la cartera total: son cifras distintas.
      money('Fiado', answer.creditedCOP, {
        sub: 'en el período',
        accent: answer.creditedCOP > 0 ? '@accentAmber' : '@textMuted',
      }),
    ],
    barsTitle: '',
    bars: [],
    emptyBars: '',
  });
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function money(
  label: string,
  amount: number,
  rest: { sub: string; accent: string },
): Cell {
  return {
    label,
    value: formatCOP(amount),
    compact: compactCOP(amount),
    ...rest,
  };
}

/** Un porcentaje o un conteo: no hay nada que abreviar. */
function plain(
  label: string,
  value: string,
  rest: { sub: string; accent: string },
): Cell {
  return { label, value, compact: value, ...rest };
}

/**
 * '$ 1,16 M' para los tiles chicos.
 *
 * El hero sí muestra la cifra completa: a 88dp de alto ocupa media pantalla de
 * ancho y cabe entera. Un tile secundario mide un tercio de eso, y ahí un
 * '$ 1.164.500' se corta a media cifra — un número cortado miente.
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
function debtBars(debt: DebtFigures) {
  const { customers, unidentified } = debt;
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

/** Tile secundario. `tile` lo inyecta el `bind` de cada casilla. */
const TILE = {
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
        fontSize: '@tileLabelSize',
        fontWeight: '600',
        maxLines: 1,
      },
      {
        type: 'Text',
        text: '${tile.compact}',
        color: '${tile.accent}',
        fontSize: '@tileValueSize',
        fontWeight: '700',
        maxLines: 1,
      },
      {
        type: 'Text',
        text: '${tile.sub}',
        color: '@textMuted',
        fontSize: '@tileSubSize',
        maxLines: 1,
      },
    ],
  },
};

/**
 * `spacing` y no `marginRight`: los márgenes no existen en APL. El separador
 * es una propiedad del hijo respecto al hermano anterior, así que el primer
 * tile va sin él.
 */
const tileAt = (index: number, first: boolean) => ({
  ...TILE,
  ...(first ? {} : { spacing: '@gap' }),
  bind: [{ name: 'tile', value: `\${payload.tiles[${index}]}` }],
});

/**
 * Dónde hay sitio para la tercera casilla y para la letra grande.
 *
 * Se escribe la condición en cada `when` en vez de guardarla en un recurso
 * booleano: los `resources` de APL son colores, dimensiones, cadenas y
 * números, y un booleano ahí es una apuesta que en el dispositivo no se ve
 * fallar, simplemente no pinta.
 */
const ROOMY = '${viewport.width >= 900 && viewport.height >= 600}';

/**
 * Layout de dos destinos: Echo Show 5 (960x480) y la app móvil, vertical.
 *
 * La regla de tamaños es la distancia de lectura, no el ancho disponible: el
 * hero se lee desde el otro lado del cuarto y todo lo demás es apoyo. La
 * tercera casilla solo aparece donde sobra pantalla; en la Show 5 su lugar lo
 * ocupa el aire que hace legibles las otras dos.
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
      description: 'Pantalla amplia: Show 8, 10, 15, Fire TV',
      dimensions: {
        heroValueSize: '124dp',
        heroLabelSize: '26dp',
        heroSubSize: '24dp',
        tileValueSize: '52dp',
        tileLabelSize: '20dp',
        tileSubSize: '19dp',
        titleSize: '36dp',
        rowSize: '28dp',
        gap: '14dp',
        tilePad: '16dp',
        pad: '30dp',
        barHeight: '12dp',
      },
    },
    {
      // La Echo Show 5 son 480dp de alto. Todo sube de tamaño y baja de
      // cantidad: se lee de lejos o no sirve de nada.
      description: 'Pantalla baja o angosta: Echo Show 5, móvil',
      when: '${viewport.height < 600 || viewport.width < 900}',
      dimensions: {
        heroValueSize: '88dp',
        heroLabelSize: '20dp',
        heroSubSize: '19dp',
        tileValueSize: '38dp',
        tileLabelSize: '16dp',
        tileSubSize: '15dp',
        titleSize: '24dp',
        rowSize: '24dp',
        gap: '10dp',
        tilePad: '12dp',
        pad: '18dp',
        barHeight: '10dp',
      },
    },
  ],
  mainTemplate: {
    parameters: ['payload'],
    items: [
      // Frame y no Container: `backgroundColor` solo existe en Frame, y en
      // Container el runtime lo ignora — el documento queda sin fondo.
      {
        type: 'Frame',
        width: '100vw',
        height: '100vh',
        backgroundColor: '@background',
        item: {
          type: 'Container',
          width: '100%',
          height: '100%',
          paddingLeft: '@pad',
          paddingRight: '@pad',
          paddingTop: '@pad',
          paddingBottom: '@pad',
          items: [
            // Encabezado: quién y cuándo, en letra pequeña a propósito.
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
                  fontSize: '@tileLabelSize',
                  fontWeight: '500',
                },
              ],
            },
            // La cifra que contesta la pregunta. Sin marco: el marco le quita
            // los dos centímetros que la hacen legible de lejos.
            {
              type: 'Container',
              width: '100%',
              paddingTop: '@gap',
              items: [
                {
                  type: 'Text',
                  text: '${payload.hero.label}',
                  color: '@textMuted',
                  fontSize: '@heroLabelSize',
                  fontWeight: '600',
                  maxLines: 1,
                },
                {
                  type: 'Text',
                  // El hero va completo: es la cifra que se vino a ver.
                  text: '${payload.hero.value}',
                  color: '${payload.hero.accent}',
                  fontSize: '@heroValueSize',
                  fontWeight: '700',
                  maxLines: 1,
                },
                {
                  type: 'Text',
                  text: '${payload.hero.sub}',
                  color: '@textMuted',
                  fontSize: '@heroSubSize',
                  maxLines: 1,
                },
              ],
            },
            // Dos casillas de apoyo, tres donde sobra pantalla.
            {
              type: 'Container',
              direction: 'row',
              width: '100%',
              paddingTop: '@gap',
              items: [
                tileAt(0, true),
                tileAt(1, false),
                { ...tileAt(2, false), when: ROOMY },
              ],
            },
            // Barras proporcionales. Sin título no hay bloque: una consulta de
            // ventas no tiene nada que comparar entre sí.
            {
              type: 'Container',
              when: '${payload.barsTitle != ""}',
              width: '100%',
              grow: 1,
              shrink: 1,
              paddingTop: '@gap',
              items: [
                {
                  type: 'Text',
                  text: '${payload.barsTitle}',
                  color: '@textMuted',
                  fontSize: '@tileLabelSize',
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
                  // Sequence y no Container: con la letra grande el tercer
                  // deudor queda bajo el borde, y sin scroll no habría cómo verlo.
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
                      paddingBottom: '9dp',
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
                          borderRadius: '5dp',
                          item: {
                            type: 'Frame',
                            width: '${data.width}',
                            height: '@barHeight',
                            backgroundColor: '@accentAmber',
                            borderRadius: '5dp',
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            // Empuja lo anterior hacia arriba cuando no hay barras.
            { type: 'Container', grow: 1, shrink: 1 },
          ],
        },
      },
    ],
  },
};
