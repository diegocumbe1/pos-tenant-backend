import { Injectable } from '@nestjs/common';
import { ReportPeriod } from '../assistant.types';

/**
 * Lo que el agente sabe hacer.
 *
 * Los nombres coinciden a propósito con los intents de Alexa (`sales_summary`,
 * `pending_payment`, …): son la misma capacidad, y compartir el id hace que la
 * telemetría de los dos canales se pueda comparar sin traducir nada.
 */
export type AgentIntent =
  | 'welcome'
  | 'options'
  | 'select_option'
  | 'switch_business'
  | 'sales_summary'
  | 'business_report'
  | 'pending_payment'
  | 'pending_delivery'
  | 'low_stock'
  | 'inventory_value'
  | 'top_products'
  | 'human_handoff'
  | 'about_lynko'
  | 'demo_request'
  | 'existing_customer'
  | 'goodbye'
  | 'unknown';

export interface IntentMatch {
  intent: AgentIntent;
  /** Período explícito del mensaje. Null = no lo dijo, hereda del contexto. */
  period: ReportPeriod | null;
  /** Número tecleado cuando la respuesta fue a un menú ("2"). */
  optionIndex: number | null;
  /** Nombre de negocio mencionado, tal cual lo escribió. Se valida después. */
  businessHint: string | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

const normalize = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

/** Una regla por capacidad. El orden decide los empates. */
const RULES: { intent: AgentIntent; patterns: RegExp[] }[] = [
  {
    intent: 'human_handoff',
    patterns: [
      /\bhablar con (alguien|una persona|un asesor|diego|el equipo|soporte)\b/,
      /\basesor\b/,
      /\bpersona real\b/,
      /\bme comuniquen\b/,
      /\bnecesito ayuda de\b/,
    ],
  },
  {
    intent: 'pending_payment',
    patterns: [
      /\bquien me debe\b/,
      /\bme deben\b/,
      /\bdeudas?\b/,
      /\bcartera\b/,
      /\bfiado\b/,
      /\bpagos? pendientes?\b/,
      /\bpor cobrar\b/,
      /\bsaldos?\b/,
    ],
  },
  {
    intent: 'pending_delivery',
    patterns: [
      /\bpor entregar\b/,
      /\bentregas? pendientes?\b/,
      /\bpedidos? pendientes?\b/,
      /\bdespachar\b/,
    ],
  },
  {
    intent: 'low_stock',
    patterns: [
      /\bse (esta|estan) acabando\b/,
      /\bpor agotarse\b/,
      /\bpoco stock\b/,
      /\bstock bajo\b/,
      /\bagotad[oa]s?\b/,
      /\bse me acabo\b/,
    ],
  },
  {
    intent: 'inventory_value',
    patterns: [
      /\bvalor del inventario\b/,
      /\bcuanto vale (mi )?(el )?inventario\b/,
      /\binventario\b/,
      /\bstock\b/,
      /\bbodega\b/,
    ],
  },
  {
    intent: 'top_products',
    patterns: [
      /\b(que|cual|cuales|lo que) mas (se )?(vend|sal)/,
      /\bmas vendidos?\b/,
      /\btop (de )?productos?\b/,
      /\bproductos? estrella\b/,
    ],
  },
  {
    intent: 'business_report',
    patterns: [
      /\breporte\b/,
      /\bresumen (del?|de mi) negocio\b/,
      /\bcomo vamos\b/,
    ],
  },
  {
    intent: 'sales_summary',
    patterns: [
      /\bcuanto (vendi|hemos vendido|se vendio|llevo)\b/,
      /\bventas?\b/,
      /\bfactur/,
      /\bcuanto llevamos\b/,
    ],
  },
  {
    intent: 'switch_business',
    patterns: [
      /\bcambia(me|r)? a\b/,
      /\bahora (en|con)\b/,
      /\bhablemos de\b/,
      /\botro negocio\b/,
      /\bcambiar de negocio\b/,
    ],
  },
  {
    intent: 'options',
    patterns: [
      /\bopciones\b/,
      /\bque puedes hacer\b/,
      /\bque (me )?puedes consultar\b/,
      /\bayuda\b/,
      /\bmenu\b/,
    ],
  },
  {
    intent: 'demo_request',
    patterns: [
      /\bdemo\b/,
      /\bdemostracion\b/,
      /\bprueba\b/,
      /\bcotiza/,
      /\bprecios?\b/,
    ],
  },
  {
    intent: 'about_lynko',
    patterns: [
      /\bque es lynko\b/,
      /\bconocer lynko\b/,
      /\binformacion\b/,
      /\bcomo funciona\b/,
    ],
  },
  {
    intent: 'existing_customer',
    patterns: [
      /\bya soy cliente\b/,
      /\btengo (una )?cuenta\b/,
      /\bsoy usuario\b/,
    ],
  },
  {
    intent: 'goodbye',
    patterns: [/\bgracias\b/, /\bchao\b/, /\bhasta luego\b/, /\blisto\b/],
  },
  {
    intent: 'welcome',
    patterns: [/\bhola\b/, /\bbuenas\b/, /\bbuenos dias\b/, /\bque mas\b/],
  },
];

/**
 * Del texto a una intención, sin modelo de lenguaje.
 *
 * En la fase 1 esto alcanza: son diez capacidades y la gente las pide con las
 * mismas cinco palabras. La estructura está pensada para que un LLM pueda
 * entrar DESPUÉS por el mismo sitio —recibir el texto, devolver `IntentMatch`—
 * sin tocar nada más del agente. El intent determinista se queda como respaldo:
 * un modelo caído no puede dejar sin respuesta a un dueño preguntando sus
 * ventas.
 */
@Injectable()
export class IntentResolverService {
  resolve(message: string, knownOptions: number): IntentMatch {
    const text = normalize(message);
    const period = this.period(text);

    // Un número suelto responde al menú anterior. Solo cuenta si de verdad se
    // ofreció un menú: si no, un "3" es basura y no una selección.
    const digits = /^(\d{1,2})[).]?$/.exec(text);
    if (digits && knownOptions > 0) {
      const index = Number(digits[1]);
      if (index >= 1 && index <= knownOptions) {
        return {
          intent: 'select_option',
          period: null,
          optionIndex: index,
          businessHint: null,
          confidence: 'HIGH',
        };
      }
    }

    for (const rule of RULES) {
      if (rule.patterns.some((p) => p.test(text))) {
        return {
          intent: rule.intent,
          period,
          optionIndex: null,
          businessHint: this.businessHint(text, rule.intent),
          confidence: 'HIGH',
        };
      }
    }

    // "¿Y ayer?" no dice qué se consulta, pero sí de cuándo: el agente repite la
    // última capacidad con el período nuevo. Es el seguimiento más común y el
    // que más molesta tener que repetir entero.
    if (period && text.split(' ').length <= 4) {
      return {
        intent: 'unknown',
        period,
        optionIndex: null,
        businessHint: null,
        confidence: 'MEDIUM',
      };
    }

    return {
      intent: 'unknown',
      period,
      optionIndex: null,
      businessHint: null,
      confidence: 'LOW',
    };
  }

  private period(text: string): ReportPeriod | null {
    if (/\bhoy\b/.test(text)) return 'day';
    // `\bayer\b` y no `includes`: "anteayer" es otra pregunta. Misma regla que
    // `parsePeriod` en report-period.ts.
    if (/\bayer\b/.test(text)) return 'yesterday';
    if (/\bsemana\b/.test(text)) return 'week';
    if (/\bmes\b/.test(text)) return 'month';
    return null;
  }

  /**
   * El negocio que nombró el mensaje, para consultas explícitas como "ventas de
   * hoy en DC Tech".
   *
   * Devuelve texto crudo a propósito: aquí no se decide nada. Quien lo resuelve
   * es `AssistantScopeService`, contra los negocios que el actor tiene
   * autorizados, y un nombre que no esté ahí no existe para esta conversación.
   */
  private businessHint(text: string, intent: AgentIntent): string | null {
    const match =
      /\b(?:en|de|para|con|a)\s+(?:el\s+|la\s+|mi\s+)?negocio\s+(.{2,40})$/.exec(
        text,
      ) ??
      (intent === 'switch_business'
        ? /\b(?:a|con|de)\s+(.{2,40})$/.exec(text)
        : null);
    const hint = match?.[1]?.trim();
    if (!hint) return null;
    // Palabras de período pegadas al final ensucian el nombre: "dc tech hoy".
    return hint.replace(/\b(hoy|ayer|semana|mes)\b/g, '').trim() || null;
  }
}
