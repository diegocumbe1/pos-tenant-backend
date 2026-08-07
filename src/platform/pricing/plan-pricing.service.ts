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

/** Redondeo comercial a mil pesos, igual que `usdToCop` en el frontend. */
export function usdToCop(usd: number, rate: number): number {
  return Math.round((usd * rate) / 1000) * 1000;
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
