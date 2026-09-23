import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Tarifas con fecha efectiva (precio de plan por vertical + tasa USD→COP).
 *
 * Las tablas `plan_prices` y `platform_rates` son APPEND-ONLY: editar un precio
 * es insertar una fila nueva con su `effectiveFrom`. Nunca se hace UPDATE ni
 * DELETE, así que el histórico no se puede perder y un cambio de tarifa solo
 * puede correr hacia adelante — los cobros ya registrados jamás se ven tocados.
 *
 * "Precio vigente a la fecha D" = la fila con el `effectiveFrom` más alto que sea
 * <= D. Consultar con la fecha del cobro es lo que hace que subir el precio en
 * septiembre no altere lo que se cobró en junio.
 */

export const VERTICAL_CODES = ['restaurant', 'barber', 'retail'] as const;
export type VerticalCode = (typeof VERTICAL_CODES)[number];

export const PLAN_CODES = ['BASIC', 'PRO', 'PREMIUM'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const DEFAULT_USD_TO_COP_RATE = 3650;

/**
 * Términos que se pueden cobrar por adelantado. El 1 está incluido a propósito:
 * es el precio de lista y su descuento es siempre 0, pero tenerlo en la lista
 * evita que la UI y el cálculo traten el caso mensual como una excepción.
 */
export const TERM_MONTHS = [1, 3, 6, 12] as const;
export type TermMonths = (typeof TERM_MONTHS)[number];

/**
 * Escalón del redondeo comercial en pesos.
 *
 * A mil el precio quedaba demasiado lejos del ancla en dólares: con la tasa en
 * 3.333, un plan de 22 USD "vale" 73.326 y se publicaba como 73.000, o sea 326
 * pesos regalados por plan y por mes. A quinientos el error máximo se parte a
 * la mitad y el precio sigue siendo una cifra que se puede decir en voz alta.
 *
 * Debe coincidir con `COP_ROUNDING_STEP` en `core/config/pricing.config.ts`:
 * si divergen, la landing publica un precio y el cobro emite otro.
 */
export const COP_ROUNDING_STEP = 500;

/** Redondeo comercial al escalón de {@link COP_ROUNDING_STEP}. */
export function roundCop(cop: number): number {
  return Math.round(cop / COP_ROUNDING_STEP) * COP_ROUNDING_STEP;
}

/** USD a COP con redondeo comercial. Igual que `usdToCop` en el frontend. */
export function usdToCop(usd: number, rate: number): number {
  return roundCop(usd * rate);
}

export interface PlanPriceRow {
  id: string;
  verticalCode: string;
  planCode: string;
  priceUSD: number;
  effectiveFrom: string;
  note?: string;
  createdBy?: string;
  createdAt: string;
}

@Injectable()
export class PlanPricingService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Lecturas por fecha ─────────────────────────────────────────────────────

  /** Precio de lista (USD) vigente para un vertical+plan en una fecha dada. */
  async getPlanPriceAt(
    verticalCode: string,
    planCode: string,
    at: Date = new Date(),
  ): Promise<number | null> {
    const row = await this.prisma.planPrice.findFirst({
      where: { verticalCode, planCode, effectiveFrom: { lte: at } },
      orderBy: { effectiveFrom: 'desc' },
    });
    return row?.priceUSD ?? null;
  }

  /** Tasa USD→COP vigente en una fecha dada. */
  async getRateAt(at: Date = new Date()): Promise<number> {
    const row = await this.prisma.platformRate.findFirst({
      where: { effectiveFrom: { lte: at } },
      orderBy: { effectiveFrom: 'desc' },
    });
    return row?.usdToCopRate ?? DEFAULT_USD_TO_COP_RATE;
  }

  /**
   * Matriz completa vigente a una fecha: cada vertical con sus tres planes en
   * USD y su equivalente en COP con la tasa de esa misma fecha.
   */
  async getPriceMatrixAt(at: Date = new Date()) {
    const [rows, rate] = await Promise.all([
      this.prisma.planPrice.findMany({
        where: { effectiveFrom: { lte: at } },
        orderBy: { effectiveFrom: 'asc' },
      }),
      this.getRateAt(at),
    ]);

    // Recorrido ascendente: la última escritura por clave gana, que es justo la
    // fila de `effectiveFrom` más alto <= at.
    const current = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      current.set(`${row.verticalCode}:${row.planCode}`, row);
    }

    const verticals = VERTICAL_CODES.map((verticalCode) => ({
      verticalCode,
      plans: PLAN_CODES.map((planCode) => {
        const row = current.get(`${verticalCode}:${planCode}`);
        return {
          planCode,
          priceUSD: row?.priceUSD ?? null,
          priceCOP: row ? usdToCop(row.priceUSD, rate) : null,
          effectiveFrom: row?.effectiveFrom.toISOString() ?? null,
          note: row?.note ?? undefined,
        };
      }),
    }));

    return { rate, at: at.toISOString(), verticals };
  }

  // ─── Descuento por anticipo ─────────────────────────────────────────────────

  /**
   * Descuento en bps vigente para (vertical, plan, término) en una fecha.
   *
   * Gana la fila MÁS ESPECÍFICA, y dentro de ese nivel la de `effectiveFrom` más
   * alto que sea <= `at`. El orden importa: si existe una excepción para
   * (retail, PREMIUM) no debe ganarle una política global publicada después.
   *
   * Sin fila, 0. Un descuento que no está escrito no existe.
   */
  async getTermDiscountBpsAt(
    verticalCode: string,
    planCode: string,
    termMonths: number,
    at: Date = new Date(),
  ): Promise<number> {
    if (termMonths <= 1) return 0;

    const rows = await this.prisma.planTermDiscount.findMany({
      where: {
        termMonths,
        effectiveFrom: { lte: at },
        OR: [
          { verticalCode, planCode },
          { verticalCode, planCode: null },
          { verticalCode: null, planCode: null },
        ],
      },
      orderBy: { effectiveFrom: 'desc' },
    });

    const bySpecificity = [
      rows.find(
        (r) => r.verticalCode === verticalCode && r.planCode === planCode,
      ),
      rows.find((r) => r.verticalCode === verticalCode && r.planCode === null),
      rows.find((r) => r.verticalCode === null && r.planCode === null),
    ];

    return bySpecificity.find((row) => row != null)?.discountBps ?? 0;
  }

  /**
   * Cotización de un cobro: qué vale de lista, cuánto se rebaja y qué se cobra.
   *
   * `agreedMonthlyCOP` es el precio pactado con ese tenant cuando existe (la
   * suscripción puede tener un descuento comercial propio). El descuento por
   * anticipo se aplica ENCIMA de ese precio, no sobre el de lista: si no, un
   * cliente con tarifa negociada recibiría dos veces la misma rebaja.
   *
   * `listAmount` sí se calcula sobre el precio de lista, porque es la cifra
   * contra la que el backoffice mide el descuento total concedido
   * (listAmount - discountAmount = amount, el invariante de la tabla).
   */
  async quoteCharge(input: {
    verticalCode: string;
    planCode: string;
    termMonths: number;
    agreedMonthlyCOP?: number | null;
    at?: Date;
  }) {
    const at = input.at ?? new Date();
    const term = Math.max(1, Math.round(input.termMonths));

    const [priceUSD, rate, discountBps] = await Promise.all([
      this.getPlanPriceAt(input.verticalCode, input.planCode, at),
      this.getRateAt(at),
      this.getTermDiscountBpsAt(input.verticalCode, input.planCode, term, at),
    ]);

    if (priceUSD == null) {
      throw new BadRequestException(
        `No hay precio de lista para ${input.verticalCode}/${input.planCode}`,
      );
    }

    const listMonthly = usdToCop(priceUSD, rate);
    const agreedMonthly = input.agreedMonthlyCOP ?? listMonthly;

    const listAmount = listMonthly * term;
    const base = agreedMonthly * term;

    // Se descuenta sobre el MENSUAL y se redondea a mil antes de multiplicar,
    // igual que en la matriz de precios. Descontar sobre el total daría cifras
    // como $636.842 en el link de pago, y además el cliente no podría verificar
    // que el total es su mensual por los meses que pagó.
    const discountedMonthly = roundCop(
      (agreedMonthly * (10000 - discountBps)) / 10000,
    );
    const amount = discountedMonthly * term;
    const termDiscount = base - amount;

    return {
      termMonths: term,
      listMonthlyCOP: listMonthly,
      agreedMonthlyCOP: agreedMonthly,
      /** Lo que termina pagando por mes. `amount` es esto por `termMonths`. */
      chargedMonthlyCOP: discountedMonthly,
      discountBps,
      /** Precio oficial del término completo, sin ninguna rebaja. */
      listAmount,
      /** Rebaja comercial ya pactada en la suscripción, extendida al término. */
      commercialDiscount: listAmount - base,
      /** Rebaja por pagar por adelantado. */
      termDiscount,
      /** Todo lo que se le perdona, que es lo que guarda `discountAmount`. */
      discountAmount: listAmount - amount,
      /** Lo que se cobra de verdad. */
      amount,
    };
  }

  /**
   * Precios con el anticipo ya aplicado: vertical × plan × término.
   *
   * Es un superconjunto de `getPriceMatrixAt` y lo consumen las DOS puntas —el
   * backoffice y la landing— a propósito. La cuenta "precio × meses − descuento"
   * se hace una sola vez, en el servidor: si cada cliente la repitiera, tarde o
   * temprano la landing mostraría un número y el cobro emitiría otro.
   */
  async getTermPricingMatrixAt(at: Date = new Date()) {
    const [matrix, rows] = await Promise.all([
      this.getPriceMatrixAt(at),
      this.prisma.planTermDiscount.findMany({
        where: { effectiveFrom: { lte: at } },
        orderBy: { effectiveFrom: 'asc' },
      }),
    ]);

    // Ascendente: la última escritura por clave gana, que es la fila de
    // `effectiveFrom` más alto <= at.
    const current = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      current.set(
        `${row.verticalCode ?? '*'}:${row.planCode ?? '*'}:${row.termMonths}`,
        row,
      );
    }

    const resolveBps = (
      verticalCode: string,
      planCode: string,
      termMonths: number,
    ): number => {
      if (termMonths <= 1) return 0;
      const candidates = [
        `${verticalCode}:${planCode}:${termMonths}`,
        `${verticalCode}:*:${termMonths}`,
        `*:*:${termMonths}`,
      ];
      for (const key of candidates) {
        const row = current.get(key);
        if (row) return row.discountBps;
      }
      return 0;
    };

    return {
      ...matrix,
      terms: [...TERM_MONTHS],
      verticals: matrix.verticals.map((vertical) => ({
        ...vertical,
        plans: vertical.plans.map((plan) => ({
          ...plan,
          terms: TERM_MONTHS.map((termMonths) => {
            const discountBps = resolveBps(
              vertical.verticalCode,
              plan.planCode,
              termMonths,
            );

            if (plan.priceUSD == null || plan.priceCOP == null) {
              return {
                termMonths,
                discountBps,
                monthlyUSD: null,
                totalCOP: null,
                monthlyCOP: null,
                savingCOP: null,
              };
            }

            // El descuento se aplica EN USD, que es el ancla de la tarifa, y el
            // COP se deriva después. Al revés —descontar sobre un COP ya
            // redondeado— el USD mostrado y el COP mostrado dejan de ser el
            // mismo precio, y encima salen cifras como $69.350, que nadie pone
            // en una lista de precios colombiana.
            //
            // `usdToCop` redondea a mil, así que el mensual queda comercial y
            // el total es un múltiplo exacto de ese mensual: el cliente puede
            // verificar la cuenta de cabeza.
            const monthlyUSD = (plan.priceUSD * (10000 - discountBps)) / 10000;
            const monthlyCOP = usdToCop(monthlyUSD, matrix.rate);
            const totalCOP = monthlyCOP * termMonths;

            return {
              termMonths,
              discountBps,
              /** Precio mensual con el descuento puesto, en la moneda ancla. */
              monthlyUSD: Math.round(monthlyUSD * 100) / 100,
              /** Equivalente mensual, que es como lo compara el cliente. */
              monthlyCOP,
              /** Lo que paga de una. */
              totalCOP,
              /** Lo que se ahorra contra pagar mes a mes ese mismo período. */
              savingCOP: plan.priceCOP * termMonths - totalCOP,
            };
          }),
        })),
      })),
    };
  }

  async getTermDiscountMatrixAt(at: Date = new Date()) {
    const rows = await this.prisma.planTermDiscount.findMany({
      where: { effectiveFrom: { lte: at } },
      orderBy: { effectiveFrom: 'asc' },
    });

    // Recorrido ascendente: la última escritura por clave gana, que es la fila
    // de `effectiveFrom` más alto <= at. Mismo truco que `getPriceMatrixAt`.
    const current = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      current.set(
        `${row.verticalCode ?? '*'}:${row.planCode ?? '*'}:${row.termMonths}`,
        row,
      );
    }

    const terms = TERM_MONTHS.filter((term) => term > 1);

    return {
      at: at.toISOString(),
      terms,
      /** Política que aplica cuando no hay excepción por vertical o plan. */
      global: terms.map((termMonths) => {
        const row = current.get(`*:*:${termMonths}`);
        return {
          termMonths,
          discountBps: row?.discountBps ?? 0,
          effectiveFrom: row?.effectiveFrom.toISOString() ?? null,
          note: row?.note ?? undefined,
        };
      }),
      /** Excepciones vigentes. Vacío es lo normal y lo deseable. */
      overrides: [...current.values()]
        .filter((row) => row.verticalCode !== null || row.planCode !== null)
        .map((row) => ({
          verticalCode: row.verticalCode,
          planCode: row.planCode,
          termMonths: row.termMonths,
          discountBps: row.discountBps,
          effectiveFrom: row.effectiveFrom.toISOString(),
          note: row.note ?? undefined,
        })),
    };
  }

  async getTermDiscountHistory(filters: {
    verticalCode?: string;
    planCode?: string;
    termMonths?: number;
  }) {
    const rows = await this.prisma.planTermDiscount.findMany({
      where: {
        ...(filters.verticalCode ? { verticalCode: filters.verticalCode } : {}),
        ...(filters.planCode ? { planCode: filters.planCode } : {}),
        ...(filters.termMonths
          ? { termMonths: Number(filters.termMonths) }
          : {}),
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });

    return {
      history: rows.map((row) => ({
        id: row.id,
        verticalCode: row.verticalCode,
        planCode: row.planCode,
        termMonths: row.termMonths,
        discountBps: row.discountBps,
        effectiveFrom: row.effectiveFrom.toISOString(),
        note: row.note ?? undefined,
        createdBy: row.createdBy ?? undefined,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async createTermDiscount(
    input: {
      verticalCode?: string | null;
      planCode?: string | null;
      termMonths: number;
      discountBps: number;
      effectiveFrom?: string;
      note?: string;
    },
    actorUserId: string,
  ) {
    if (!TERM_MONTHS.includes(input.termMonths as TermMonths)) {
      throw new BadRequestException(`Unknown term ${input.termMonths}`);
    }
    if (input.termMonths === 1) {
      throw new BadRequestException(
        'El término mensual es el precio de lista: no admite descuento',
      );
    }
    if (
      input.verticalCode &&
      !VERTICAL_CODES.includes(input.verticalCode as VerticalCode)
    ) {
      throw new BadRequestException(`Unknown vertical ${input.verticalCode}`);
    }
    if (input.planCode && !PLAN_CODES.includes(input.planCode as PlanCode)) {
      throw new BadRequestException(`Unknown plan ${input.planCode}`);
    }

    const bps = Math.round(input.discountBps);
    // El techo no es capricho: por encima de ~30% el anticipo deja de ser un
    // incentivo y se vuelve una venta a pérdida disfrazada. Que sea un error y
    // no un aviso evita el dedo gordo de escribir 5000 en vez de 500.
    if (!Number.isInteger(bps) || bps < 0 || bps > 3000) {
      throw new BadRequestException(
        'discountBps debe estar entre 0 y 3000 (0% a 30%)',
      );
    }

    const row = await this.prisma.planTermDiscount.create({
      data: {
        verticalCode: input.verticalCode || null,
        planCode: input.planCode || null,
        termMonths: input.termMonths,
        discountBps: bps,
        effectiveFrom: this.parseEffectiveFrom(input.effectiveFrom),
        note: input.note,
        createdBy: actorUserId,
      },
    });

    return {
      id: row.id,
      verticalCode: row.verticalCode,
      planCode: row.planCode,
      termMonths: row.termMonths,
      discountBps: row.discountBps,
      effectiveFrom: row.effectiveFrom.toISOString(),
      note: row.note ?? undefined,
      createdBy: row.createdBy ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // ─── Histórico (solo super admin: los endpoints van tras PlatformAdminGuard) ──

  async getPlanPriceHistory(filters: {
    verticalCode?: string;
    planCode?: string;
  }) {
    const rows = await this.prisma.planPrice.findMany({
      where: {
        ...(filters.verticalCode ? { verticalCode: filters.verticalCode } : {}),
        ...(filters.planCode ? { planCode: filters.planCode } : {}),
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return { history: rows.map((row) => this.toDto(row)) };
  }

  async getRateHistory() {
    const rows = await this.prisma.platformRate.findMany({
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return {
      history: rows.map((row) => ({
        id: row.id,
        rate: row.usdToCopRate,
        usdToCopRate: row.usdToCopRate,
        effectiveFrom: row.effectiveFrom.toISOString(),
        note: row.note ?? undefined,
        createdBy: row.createdBy ?? undefined,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  // ─── Escrituras (siempre INSERT) ────────────────────────────────────────────

  async createPlanPrice(
    input: {
      verticalCode: string;
      planCode: string;
      priceUSD: number;
      effectiveFrom?: string;
      note?: string;
    },
    actorUserId: string,
  ): Promise<PlanPriceRow> {
    if (!VERTICAL_CODES.includes(input.verticalCode as VerticalCode)) {
      throw new BadRequestException(`Unknown vertical ${input.verticalCode}`);
    }
    if (!PLAN_CODES.includes(input.planCode as PlanCode)) {
      throw new BadRequestException(`Unknown plan ${input.planCode}`);
    }

    const row = await this.prisma.planPrice.create({
      data: {
        verticalCode: input.verticalCode,
        planCode: input.planCode,
        priceUSD: Math.round(input.priceUSD),
        effectiveFrom: this.parseEffectiveFrom(input.effectiveFrom),
        note: input.note,
        createdBy: actorUserId,
      },
    });
    return this.toDto(row);
  }

  async createRate(
    input: { rate: number; effectiveFrom?: string; note?: string },
    actorUserId: string,
  ) {
    const rate = Math.round(input.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new BadRequestException('rate must be a positive integer');
    }

    const effectiveFrom = this.parseEffectiveFrom(input.effectiveFrom);

    // La fila única legacy se mantiene sincronizada en la misma transacción: ya
    // no es la fuente de verdad, pero cualquier lector viejo sigue viendo la
    // tasa correcta. Solo se pisa cuando la tarifa nueva es la que rige HOY.
    const [row] = await this.prisma.$transaction([
      this.prisma.platformRate.create({
        data: {
          usdToCopRate: rate,
          effectiveFrom,
          note: input.note,
          createdBy: actorUserId,
        },
      }),
      this.prisma.platformPricingConfig.upsert({
        where: { id: 'singleton' },
        update:
          effectiveFrom <= new Date()
            ? { usdToCopRate: rate, updatedBy: actorUserId }
            : {},
        create: { id: 'singleton', usdToCopRate: rate, updatedBy: actorUserId },
      }),
    ]);

    return {
      id: row.id,
      rate: row.usdToCopRate,
      usdToCopRate: row.usdToCopRate,
      effectiveFrom: row.effectiveFrom.toISOString(),
      note: row.note ?? undefined,
      createdBy: row.createdBy ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Sin fecha, la tarifa rige desde ya. Con fecha, se respeta tal cual: el
   * frontend manda un ISO construido desde una fecha de calendario colombiana
   * (convención del proyecto), así que aquí no se re-interpreta la zona.
   */
  private parseEffectiveFrom(value?: string): Date {
    if (!value) return new Date();
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid effectiveFrom: ${value}`);
    }
    return parsed;
  }

  private toDto(row: {
    id: string;
    verticalCode: string;
    planCode: string;
    priceUSD: number;
    effectiveFrom: Date;
    note: string | null;
    createdBy: string | null;
    createdAt: Date;
  }): PlanPriceRow {
    return {
      id: row.id,
      verticalCode: row.verticalCode,
      planCode: row.planCode,
      priceUSD: row.priceUSD,
      effectiveFrom: row.effectiveFrom.toISOString(),
      note: row.note ?? undefined,
      createdBy: row.createdBy ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
