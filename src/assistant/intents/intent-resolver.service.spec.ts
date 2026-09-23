import { AgentIntent, IntentResolverService } from './intent-resolver.service';
import { ReportPeriod } from '../assistant.types';

/**
 * El banco de frases del agente.
 *
 * Está escrito COMO ESCRIBE LA GENTE: con tildes y sin ellas, en minúsculas,
 * con el español de mostrador. Si una frase razonable falla, el arreglo casi
 * siempre es el lexicón —un archivo de datos— y no el motor.
 *
 * Gemelo de `scripts/check-lynko-intents.ts` en el frontend. Una frase que
 * funcione en el chat web y no aquí es un bug: es el mismo copiloto.
 */
interface Case {
  text: string;
  intent: AgentIntent;
  period?: ReportPeriod;
  business?: string;
  needsPeriod?: boolean;
}

const BUSINESSES = ['Bella Chic', 'DC Tech', 'Malexca'];

const CASES: Case[] = [
  // ─── Las frases que originaron este trabajo ───────────────────────────────
  { text: 'dame reporte solo de ventas', intent: 'sales_summary' },
  { text: 'dame reporte general', intent: 'business_report' },
  {
    text: 'dame reporte solo de gastos de los ultimos 15 dias',
    intent: 'expenses_summary',
    period: 'last:15',
  },
  {
    text: 'dame reporte de clientes de bella chic',
    intent: 'top_customers',
    business: 'Bella Chic',
  },
  {
    text: 'que pedidos tengo pendientes por recibir en DC tech',
    intent: 'pending_purchase',
    business: 'DC Tech',
  },
  { text: 'cuantos productos he vendido', intent: 'units_sold' },

  // ─── Ventas ───────────────────────────────────────────────────────────────
  { text: 'cuanto vendi hoy', intent: 'sales_summary', period: 'day' },
  { text: '¿Cuánto vendí ayer?', intent: 'sales_summary', period: 'yesterday' },
  { text: 'cuanto llevo este mes', intent: 'sales_summary', period: 'month' },
  {
    text: 'cuanto facture el mes pasado',
    intent: 'sales_summary',
    period: 'lastMonth',
  },
  {
    text: 'ventas de los ultimos 7 dias',
    intent: 'sales_summary',
    period: 'last:7',
  },
  {
    text: 'cuanta plata entro la semana pasada',
    intent: 'sales_summary',
    period: 'lastWeek',
  },
  { text: 'como van las ventas', intent: 'sales_summary' },
  {
    text: 'dame las ventas de bella chic',
    intent: 'sales_summary',
    business: 'Bella Chic',
  },
  // El caso peligroso: pide un total y no dice de cuándo. Hay que PREGUNTAR.
  {
    text: 'cuanto llevo en ventas totales',
    intent: 'sales_summary',
    needsPeriod: true,
  },

  // ─── Unidades ─────────────────────────────────────────────────────────────
  {
    text: 'cuantas unidades he vendido este mes',
    intent: 'units_sold',
    period: 'month',
  },
  { text: 'cuantos productos vendi ayer', intent: 'units_sold', period: 'yesterday' },

  // ─── Gastos ───────────────────────────────────────────────────────────────
  { text: 'cuanto he gastado este mes', intent: 'expenses_summary', period: 'month' },
  { text: 'en que se me va la plata', intent: 'expenses_summary' },
  { text: 'dame los gastos de marzo', intent: 'expenses_summary' },
  { text: 'cuanto pague de arriendo', intent: 'expenses_summary' },

  // ─── Cartera ──────────────────────────────────────────────────────────────
  { text: 'quien me debe', intent: 'pending_payment' },
  { text: 'cuanto me deben', intent: 'pending_payment' },
  { text: 'como va la cartera', intent: 'pending_payment' },
  { text: 'que saldos tengo pendientes', intent: 'pending_payment' },

  // ─── Pedidos que SALEN vs. pedidos que ENTRAN ─────────────────────────────
  { text: 'que tengo por entregar', intent: 'pending_delivery' },
  { text: 'cuantos pedidos faltan por entregar', intent: 'pending_delivery' },
  { text: 'que me falta despachar', intent: 'pending_delivery' },
  { text: 'que pedidos tengo por recibir', intent: 'pending_purchase' },
  { text: 'que le pedi al proveedor', intent: 'pending_purchase' },
  { text: 'que compras tengo pendientes', intent: 'pending_purchase' },

  // ─── Inventario ───────────────────────────────────────────────────────────
  { text: 'que se esta acabando', intent: 'low_stock' },
  { text: 'que productos tienen stock bajo', intent: 'low_stock' },
  { text: 'que deberia reponer', intent: 'low_stock' },
  { text: 'que productos estan agotados', intent: 'out_of_stock' },
  { text: 'que se me acabo', intent: 'out_of_stock' },
  { text: 'que productos estan en cero', intent: 'out_of_stock' },
  { text: 'cuanto vale mi inventario', intent: 'inventory_value' },
  { text: 'como esta mi inventario', intent: 'inventory_value' },

  // ─── Rankings ─────────────────────────────────────────────────────────────
  { text: 'que es lo que mas vendo', intent: 'top_products' },
  { text: 'cual es el producto mas vendido', intent: 'top_products' },
  { text: 'que es lo que menos se vende', intent: 'worst_products' },
  { text: 'que productos estan quietos', intent: 'worst_products' },
  { text: 'quien me compra mas', intent: 'top_customers' },
  { text: 'cual es mi mejor cliente', intent: 'top_customers' },

  // ─── Reporte general ──────────────────────────────────────────────────────
  { text: 'dame el reporte', intent: 'business_report' },
  { text: 'como vamos', intent: 'business_report' },
  { text: 'ponme al dia', intent: 'business_report' },
  { text: 'resumen del negocio', intent: 'business_report' },

  // ─── Conversación ─────────────────────────────────────────────────────────
  { text: 'hola', intent: 'welcome' },
  { text: 'gracias', intent: 'goodbye' },
  { text: 'eres un bot?', intent: 'is_bot' },
  { text: 'quiero hablar con un asesor', intent: 'human_handoff' },
  { text: 'que puedes hacer', intent: 'options' },

  // ─── Lo que NO debe resolver ──────────────────────────────────────────────
  // Adivinar acá es peor que ofrecer opciones.
  { text: 'necesito que me ayudes con una cosa rara', intent: 'unknown' },
  { text: 'asdkjhasd', intent: 'unknown' },
];

describe('IntentResolverService', () => {
  const resolver = new IntentResolverService();
  const resolve = (text: string) =>
    resolver.resolve(text, { businessNames: BUSINESSES });

  describe('corpus', () => {
    for (const testCase of CASES) {
      it(`"${testCase.text}" → ${testCase.intent}`, () => {
        const match = resolve(testCase.text);
        expect(match.intent).toBe(testCase.intent);
        if (testCase.period !== undefined) {
          expect(match.period).toBe(testCase.period);
        }
        if (testCase.business !== undefined) {
          expect(match.businessHint).toBe(testCase.business);
        }
        if (testCase.needsPeriod !== undefined) {
          expect(match.needsPeriod).toBe(testCase.needsPeriod);
        }
      });
    }
  });

  describe('negocio mencionado', () => {
    it('reconoce el nombre sin exigir la palabra "negocio"', () => {
      expect(resolve('ventas de bella chic').businessHint).toBe('Bella Chic');
    });

    it('lo reconoce aunque venga pegado o sin espacios', () => {
      expect(resolve('cuanto vendio bellachic hoy').businessHint).toBe(
        'Bella Chic',
      );
    });

    it('ignora un negocio que el actor no tiene', () => {
      expect(resolve('ventas de panaderia el trigo').businessHint).toBeNull();
    });

    it('prefiere el nombre más largo cuando hay dos que coinciden', () => {
      const match = resolver.resolve('ventas de dc tech', {
        businessNames: ['DC', 'DC Tech'],
      });
      expect(match.businessHint).toBe('DC Tech');
    });
  });

  describe('menús', () => {
    it('lee un número como selección solo si hubo menú', () => {
      expect(resolver.resolve('2', { knownOptions: 3 }).intent).toBe(
        'select_option',
      );
      expect(resolver.resolve('2', { knownOptions: 0 }).intent).toBe('unknown');
    });

    it('ignora un número fuera del rango ofrecido', () => {
      expect(resolver.resolve('9', { knownOptions: 3 }).intent).toBe('unknown');
    });
  });

  describe('seguimiento', () => {
    it('trata "¿y ayer?" como un cambio de período, no como ruido', () => {
      const match = resolve('y ayer?');
      expect(match.intent).toBe('unknown');
      expect(match.period).toBe('yesterday');
      expect(match.confidence).toBe('MEDIUM');
    });
  });
});
