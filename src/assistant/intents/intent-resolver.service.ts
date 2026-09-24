import { Injectable } from '@nestjs/common';
import { ReportPeriod } from '../assistant.types';
import { parsePeriodText } from '../report-period';
import { LEXICON, TOTALIZING_TERMS } from './lexicon';

/**
 * Lo que el agente sabe hacer.
 *
 * Los nombres coinciden a propósito con los intents de Alexa (`sales_summary`,
 * `pending_payment`, …) y con los del chat web (`verticals/retail/assistant/`):
 * son la misma capacidad, y compartir el id hace que la telemetría de los tres
 * canales se pueda comparar sin traducir nada.
 */
export type AgentIntent =
  | 'welcome'
  | 'options'
  | 'select_option'
  | 'switch_business'
  | 'sales_summary'
  | 'units_sold'
  | 'expenses_summary'
  | 'business_report'
  | 'pending_payment'
  | 'pending_delivery'
  | 'pending_purchase'
  | 'low_stock'
  | 'out_of_stock'
  | 'inventory_value'
  | 'top_products'
  | 'worst_products'
  | 'top_customers'
  | 'human_handoff'
  | 'is_bot'
  | 'about_lynko'
  | 'demo_request'
  | 'existing_customer'
  | 'goodbye'
  | 'unknown';

export interface IntentMatch {
  intent: AgentIntent;
  /** Período explícito del mensaje. Null = no lo dijo, hereda del contexto. */
  period: ReportPeriod | null;
  /**
   * Pidió una cifra acumulada sin decir de cuándo ("ventas totales").
   *
   * No es lo mismo que no decir nada: quien pregunta "¿cuánto llevo en total?"
   * merece que le pregunten el período, no que le contesten con las de hoy.
   */
  needsPeriod: boolean;
  /** Número tecleado cuando la respuesta fue a un menú ("2"). */
  optionIndex: number | null;
  /** Negocio mencionado, ya resuelto contra los que el actor tiene. */
  businessHint: string | null;
  /**
   * Nombró un negocio con todas las letras y NO es de los suyos.
   *
   * Es distinto de `businessHint: null`, que solo significa "no nombró
   * ninguno". Sin esta señal, "ventas de hoy en el negocio Malexca" de alguien
   * que solo tiene Bella Chic se respondía con las cifras de Bella Chic, sin
   * avisar: la respuesta correcta a la pregunta equivocada.
   */
  unknownBusiness: boolean;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  /** Los siguientes mejores candidatos, para poder repreguntar con sentido. */
  alternatives: AgentIntent[];
}

export interface ResolveOptions {
  /** Cuántas opciones se ofrecieron en el turno anterior. 0 = ninguna. */
  knownOptions?: number;
  /**
   * Nombres de los negocios que este actor puede consultar.
   *
   * Se pasan para poder reconocer "de bella chic" sin exigir la palabra
   * "negocio". Antes el nombre se extraía con un regex que pedía `de negocio
   * <algo>`, así que "ventas de bella chic" perdía el negocio entero y
   * respondía sobre el que estuviera recordado —la cifra correcta del negocio
   * equivocado—.
   */
  businessNames?: string[];
}

interface TermGroup {
  terms: string[];
  w: number;
}

interface IntentRule {
  intent: AgentIntent;
  /** Sin al menos un anchor no hay intento, por más modificadores que peguen. */
  anchors: TermGroup[];
  modifiers?: TermGroup[];
  /** Términos que EMPUJAN hacia otro intent: restan. */
  negative?: string[];
  /** Mencionar un período es evidencia de que se pregunta por cifras. */
  scopeBoost?: number;
}

/**
 * "…en el negocio Malexca", "…de la tienda Bella Chic".
 *
 * No sirve para SABER cuál negocio es —eso lo hace `businessIn` contra la lista
 * real—, sino para saber que el usuario nombró uno. Es la única forma de
 * distinguir "no dijo de cuál" de "dijo uno que no es suyo".
 */
const NAMED_BUSINESS =
  /\b(?:en|de|para|con)\s+(?:el\s+|la\s+|mi\s+)?(?:negocio|tienda|local)\s+\S{2,}/;

/** Cuánto resta cada término negativo. Dos negativos hunden un match mediocre. */
const NEGATIVE_PENALTY = 0.25;

/** Umbrales de confianza. Debajo de CLARIFY el agente no adivina. */
const ANSWER = 0.6;
const CLARIFY = 0.35;

const normalize = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenize = (normalized: string): string[] =>
  normalized ? normalized.split(' ') : [];

/**
 * ¿Aparece el término en el texto?
 *
 * Una sola palabra se busca entre los TOKENS y no como subcadena, para que
 * "venta" no coincida dentro de "ventanilla" ni "caja" dentro de "cajas". Un
 * término de varias palabras sí se busca como subcadena, porque "como va" tiene
 * que encontrarse dentro de "como va el negocio".
 */
function hasTerm(normalized: string, tokens: string[], term: string): boolean {
  return term.includes(' ')
    ? tokens.includes(term) || normalized.includes(term)
    : tokens.includes(term);
}

/**
 * Añade a los tokens el NOMBRE del concepto cuando alguna de sus formas aparece.
 *
 * Así las reglas se escriben contra `venta` y no contra las veinte maneras de
 * decirlo. El nombre del concepto puede tener espacios ("sin stock"), y por eso
 * `hasTerm` también mira `tokens.includes` en su rama multipalabra.
 */
function expandWithLexicon(normalized: string, tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const [concept, forms] of Object.entries(LEXICON)) {
    if (forms.some((form) => hasTerm(normalized, tokens, form))) {
      expanded.add(concept);
    }
  }
  return [...expanded];
}

/**
 * El catálogo de reglas.
 *
 * El ORDEN YA NO DECIDE NADA: gana el puntaje más alto. Ese era el defecto de
 * la versión anterior —un array recorrido en orden donde el primer patrón que
 * coincidía ganaba—, y por eso "dame el reporte de ventas" se resolvía como el
 * reporte completo: la regla de `reporte` estaba antes que la de `venta` y se
 * llevaba cualquier frase que dijera la palabra.
 */
const RULES: IntentRule[] = [
  // ─── Conversación ────────────────────────────────────────────────────────
  {
    // Va con peso alto: "¿eres un robot?" se responde con la verdad antes que
    // cualquier otra cosa, y nunca se deja pasar como si no se hubiera oído.
    intent: 'is_bot',
    anchors: [
      {
        terms: [
          'bot',
          'robot',
          'maquina',
          'inteligencia artificial',
          'ia',
          'humano',
          'con quien hablo',
          'con quien estoy hablando',
          'eres una persona',
          'sos una persona',
          'esto es automatico',
        ],
        w: 0.9,
      },
    ],
  },
  {
    intent: 'human_handoff',
    anchors: [
      {
        terms: [
          'asesor',
          'persona real',
          'me comuniquen',
          'hablar con alguien',
          'hablar con una persona',
          'hablar con un asesor',
          'hablar con el equipo',
          'hablar con soporte',
          // Por nombre propio: es como se pide de verdad en un chat con un
          // proveedor pequeño, y el detector anterior ya lo contemplaba.
          'hablar con diego',
          'necesito ayuda de',
        ],
        w: 0.9,
      },
    ],
  },

  // ─── Plata ───────────────────────────────────────────────────────────────
  {
    intent: 'sales_summary',
    anchors: [{ terms: ['venta'], w: 0.5 }],
    modifiers: [{ terms: ['cuanto', 'reporte', 'total'], w: 0.2 }],
    // Todo esto también habla de ventas, pero lo responde otro intent.
    negative: [
      'fiado',
      'entrega',
      'compra',
      'cliente',
      'top',
      'peor',
      'producto',
      'gasto',
    ],
    scopeBoost: 0.15,
  },
  {
    /**
     * "¿Cuántos productos he vendido?" — UNIDADES, no pesos.
     *
     * El dato ya se calculaba (`SalesFigures.unitsSold`) pero no había forma de
     * pedirlo: la pregunta caía en `unknown` y el agente ofrecía el menú.
     */
    intent: 'units_sold',
    anchors: [{ terms: ['producto'], w: 0.4 }],
    modifiers: [
      { terms: ['venta'], w: 0.35 },
      { terms: ['cuanto'], w: 0.25 },
    ],
    // Si nombran un ranking o el inventario, no preguntan por el total de
    // unidades movidas.
    negative: [
      'top',
      'peor',
      'inventario',
      'agotado',
      'sin stock',
      'cliente',
      'compra',
    ],
    scopeBoost: 0.1,
  },
  {
    intent: 'expenses_summary',
    anchors: [{ terms: ['gasto'], w: 0.6 }],
    modifiers: [{ terms: ['cuanto', 'reporte', 'cual'], w: 0.2 }],
    negative: ['venta', 'fiado', 'compra'],
    scopeBoost: 0.15,
  },
  {
    intent: 'pending_payment',
    anchors: [{ terms: ['fiado'], w: 0.6 }],
    modifiers: [{ terms: ['cuanto', 'cual', 'quien', 'reporte'], w: 0.2 }],
    negative: ['entrega', 'compra', 'gasto'],
  },

  // ─── Mercancía ───────────────────────────────────────────────────────────
  {
    intent: 'out_of_stock',
    anchors: [{ terms: ['sin stock'], w: 0.6 }],
    modifiers: [
      { terms: ['producto', 'inventario'], w: 0.2 },
      { terms: ['cual', 'cuanto'], w: 0.1 },
    ],
    negative: ['venta', 'fiado'],
  },
  {
    intent: 'low_stock',
    anchors: [
      { terms: ['agotado'], w: 0.5 },
      { terms: ['inventario', 'producto'], w: 0.25 },
    ],
    modifiers: [{ terms: ['cual', 'cuanto'], w: 0.1 }],
    negative: ['venta', 'fiado', 'compra', 'top', 'peor'],
  },
  {
    intent: 'inventory_value',
    anchors: [{ terms: ['inventario'], w: 0.5 }],
    modifiers: [
      {
        terms: ['cuanto', 'valor', 'vale', 'plata', 'total', 'reporte'],
        w: 0.25,
      },
      { terms: ['tengo', 'hay'], w: 0.1 },
    ],
    negative: ['agotado', 'sin stock', 'venta', 'compra'],
  },

  // ─── Pedidos: los que SALEN y los que ENTRAN ─────────────────────────────
  {
    /**
     * Lo que le pedimos al PROVEEDOR y no ha llegado.
     *
     * Se separa de `pending_delivery` con negativos fuertes en los dos lados:
     * "pedidos pendientes" a secas es ambiguo, y antes se lo llevaba entero
     * `pending_delivery` —lo que sale— aunque la pregunta dijera "por recibir".
     */
    intent: 'pending_purchase',
    anchors: [{ terms: ['compra'], w: 0.6 }],
    modifiers: [
      {
        terms: ['cuanto', 'cual', 'que tengo', 'pendiente', 'pendientes'],
        w: 0.2,
      },
    ],
    negative: ['entrega', 'cliente', 'venta'],
  },
  {
    intent: 'pending_delivery',
    anchors: [{ terms: ['entrega'], w: 0.6 }],
    modifiers: [
      {
        terms: ['cuanto', 'cual', 'que tengo', 'pendiente', 'pendientes'],
        w: 0.2,
      },
    ],
    negative: ['compra', 'fiado'],
  },

  // ─── Rankings ────────────────────────────────────────────────────────────
  {
    intent: 'top_customers',
    anchors: [{ terms: ['cliente'], w: 0.5 }],
    modifiers: [
      { terms: ['top'], w: 0.35 },
      { terms: ['quien', 'cual', 'reporte', 'cuanto'], w: 0.2 },
    ],
    negative: ['fiado', 'entrega', 'peor'],
    scopeBoost: 0.15,
  },
  {
    intent: 'worst_products',
    anchors: [{ terms: ['venta', 'producto'], w: 0.4 }],
    // "qué no se ha vendido", "qué está quieto": ninguna dice "menos", y todas
    // son la misma pregunta.
    modifiers: [{ terms: ['peor'], w: 0.45 }],
    negative: ['top', 'cliente', 'fiado', 'entrega', 'compra'],
    scopeBoost: 0.1,
  },
  {
    intent: 'top_products',
    anchors: [{ terms: ['venta', 'producto'], w: 0.4 }],
    modifiers: [{ terms: ['top'], w: 0.45 }],
    negative: ['peor', 'cliente', 'fiado', 'entrega', 'compra'],
    scopeBoost: 0.1,
  },

  // ─── El negocio entero ───────────────────────────────────────────────────
  {
    intent: 'business_report',
    anchors: [{ terms: ['reporte'], w: 0.5 }],
    modifiers: [{ terms: ['negocio', 'general'], w: 0.25 }],
    /**
     * Si el usuario NOMBRA un tema concreto, no quiere el reporte general.
     *
     * Este es el negativo que arregla "dame el reporte de ventas": sin él,
     * `reporte` valía 0.5 y ganaba, porque las reglas se evaluaban en orden.
     * Ahora `sales_summary` suma 0.5 del anchor + 0.2 del modificador
     * `reporte`, y el reporte general baja a 0.25. Gana el que responde la
     * pregunta.
     */
    negative: [
      'venta',
      'gasto',
      'fiado',
      'entrega',
      'compra',
      'cliente',
      'agotado',
      'sin stock',
      'inventario',
      'producto',
    ],
    scopeBoost: 0.1,
  },

  // ─── Navegación ──────────────────────────────────────────────────────────
  {
    intent: 'switch_business',
    anchors: [
      {
        terms: [
          'cambiame a',
          'cambiar a',
          'cambia a',
          'otro negocio',
          'cambiar de negocio',
          'hablemos de',
          'ahora en',
          'ahora con',
        ],
        w: 0.8,
      },
    ],
  },
  {
    intent: 'options',
    anchors: [
      {
        terms: [
          'opciones',
          'que puedes hacer',
          'que puedes consultar',
          'que me puedes consultar',
          'que sabes hacer',
          'ayuda',
          'menu',
        ],
        w: 0.8,
      },
    ],
  },
  {
    intent: 'demo_request',
    anchors: [
      {
        terms: [
          'demo',
          'demostracion',
          'cotizar',
          'cotizacion',
          'precio',
          'precios',
        ],
        w: 0.8,
      },
    ],
  },
  {
    intent: 'about_lynko',
    anchors: [
      {
        terms: [
          'que es lynko',
          'conocer lynko',
          'informacion',
          'como funciona',
        ],
        w: 0.8,
      },
    ],
  },
  {
    intent: 'existing_customer',
    anchors: [
      {
        terms: [
          'ya soy cliente',
          'tengo una cuenta',
          'tengo cuenta',
          'soy usuario',
        ],
        w: 0.85,
      },
    ],
  },
  {
    intent: 'goodbye',
    anchors: [{ terms: ['gracias', 'chao', 'hasta luego', 'listo'], w: 0.8 }],
  },
  {
    intent: 'welcome',
    anchors: [{ terms: ['hola', 'buenas', 'buenos dias', 'que mas'], w: 0.8 }],
  },
];

/**
 * Del texto a una intención, con CONFIANZA y sin modelo de lenguaje.
 *
 * Cada intent declara términos con peso; la confianza es la suma de lo que hizo
 * match, acotada a 1. Eso es lo que permite distinguir "estoy seguro" de
 * "adiviné", que es justo lo que hace falta para decidir entre responder,
 * repreguntar o mostrar opciones.
 *
 * La estructura está pensada para que un LLM pueda entrar DESPUÉS por el mismo
 * sitio —recibir el texto, devolver `IntentMatch`— sin tocar nada más del
 * agente. Este resolver se queda como respaldo: un modelo caído no puede dejar
 * sin respuesta a un dueño preguntando sus ventas.
 */
@Injectable()
export class IntentResolverService {
  resolve(message: string, options: ResolveOptions = {}): IntentMatch {
    const { knownOptions = 0, businessNames = [] } = options;
    const normalized = normalize(message);
    const tokens = expandWithLexicon(normalized, tokenize(normalized));

    const period = parsePeriodText(message);
    const businessHint = this.businessIn(normalized, businessNames);
    // La construcción explícita ("en el negocio X") es prueba de que el usuario
    // acotó la pregunta a un negocio concreto. Si además no es de los suyos, la
    // pregunta no tiene respuesta y hay que decirlo, no contestar por otro.
    const unknownBusiness =
      !businessHint &&
      NAMED_BUSINESS.test(normalized) &&
      businessNames.length > 0;
    const needsPeriod =
      period === null &&
      TOTALIZING_TERMS.some((term) => hasTerm(normalized, tokens, term));

    // Un número suelto responde al menú anterior. Solo cuenta si de verdad se
    // ofreció un menú: si no, un "3" es basura y no una selección.
    const digits = /^(\d{1,2})[).]?$/.exec(normalized);
    if (digits && knownOptions > 0) {
      const index = Number(digits[1]);
      if (index >= 1 && index <= knownOptions) {
        return {
          intent: 'select_option',
          period: null,
          needsPeriod: false,
          optionIndex: index,
          businessHint: null,
          unknownBusiness: false,
          confidence: 'HIGH',
          alternatives: [],
        };
      }
    }

    const ranked = RULES.map((rule) => ({
      intent: rule.intent,
      score: this.score(rule, normalized, tokens, period !== null),
    }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];

    // Nada puntuó. "¿Y ayer?" no dice qué se consulta, pero sí de cuándo: el
    // agente repite la última capacidad con el período nuevo. Es el seguimiento
    // más común y el que más molesta tener que repetir entero.
    if (!best) {
      return {
        intent: 'unknown',
        period,
        needsPeriod,
        optionIndex: null,
        businessHint,
        unknownBusiness,
        confidence:
          period && normalized.split(' ').length <= 4 ? 'MEDIUM' : 'LOW',
        alternatives: [],
      };
    }

    // Solo mencionó un negocio ("bella chic", a secas). No es una pregunta:
    // es un cambio de contexto, y responderle con una capacidad inventada
    // sería peor que preguntar de qué quiere saber.
    const confidence =
      best.score >= ANSWER ? 'HIGH' : best.score >= CLARIFY ? 'MEDIUM' : 'LOW';

    return {
      intent: confidence === 'LOW' ? 'unknown' : best.intent,
      period,
      needsPeriod,
      optionIndex: null,
      businessHint,
      unknownBusiness,
      confidence,
      alternatives: ranked.slice(1, 3).map((c) => c.intent),
    };
  }

  private score(
    rule: IntentRule,
    normalized: string,
    tokens: string[],
    hasPeriod: boolean,
  ): number {
    const groupScore = (groups: TermGroup[]): number => {
      let total = 0;
      for (const group of groups) {
        // Un grupo puntúa UNA sola vez aunque coincidan tres de sus términos:
        // si no, escribir el mismo concepto de dos maneras en la misma frase
        // inflaría la confianza sin aportar evidencia nueva.
        if (group.terms.some((term) => hasTerm(normalized, tokens, term))) {
          total += group.w;
        }
      }
      return total;
    };

    const anchorScore = groupScore(rule.anchors);
    // Sin anchor no hay intento. Esto es lo que evita que un "¿cuánto?" suelto
    // resuelva cualquier cosa.
    if (anchorScore === 0) return 0;

    let score = anchorScore + groupScore(rule.modifiers ?? []);
    if (hasPeriod && rule.scopeBoost) score += rule.scopeBoost;

    const negatives = (rule.negative ?? []).filter((term) =>
      hasTerm(normalized, tokens, term),
    ).length;
    score -= negatives * NEGATIVE_PENALTY;

    return Math.max(0, Math.min(1, score));
  }

  /**
   * El negocio que nombra el mensaje, resuelto contra los que el actor TIENE.
   *
   * Se compara contra la lista real en vez de extraer texto con un regex: así
   * "ventas de bella chic", "bella chic cuánto vendí" y "cómo va bellachic"
   * funcionan igual, y un nombre que no esté en la lista simplemente no
   * existe para esta conversación. La autorización no cambia: quien decide qué
   * puede ver esa cuenta sigue siendo `AssistantScopeService`.
   *
   * Gana el nombre más largo que coincida, para que "DC Tech" no pierda contra
   * un hipotético "DC".
   */
  private businessIn(normalized: string, names: string[]): string | null {
    const compact = (value: string) =>
      value
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');

    const haystack = compact(normalized);
    let found: string | null = null;
    for (const name of names) {
      const needle = compact(name);
      // Dos caracteres no identifican nada y harían match dentro de cualquier
      // palabra: un negocio llamado "DC" se reconoce por el menú, no por azar.
      if (needle.length < 3 || !haystack.includes(needle)) continue;
      if (!found || needle.length > compact(found).length) found = name;
    }
    return found;
  }
}
