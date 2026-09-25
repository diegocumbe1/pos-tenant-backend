import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DEFAULT_FEE_RATES,
  FEE_METHODS,
  FeeMethod,
  FeeQuote,
  FeeRate,
  quoteFee,
} from '../fee-calculator';

/** Un medio con su tarifa vigente y el simulador ya resuelto. */
export interface FeeRateRow extends FeeRate {
  id: string | null;
  effectiveFrom: string | null;
  note: string | null;
}

@Injectable()
export class FeeRatesService {
  private readonly logger = new Logger(FeeRatesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tarifa vigente de un medio A UNA FECHA: la fila con el `effectiveFrom` más
   * alto que sea <= esa fecha. Misma regla que `plan_prices`, para que subir
   * una tarifa hoy no reescriba lo que costó un cobro de junio.
   */
  async rateAt(method: FeeMethod, at: Date = new Date()): Promise<FeeRate> {
    const row = await this.prisma.platformGatewayFee.findFirst({
      where: { method, effectiveFrom: { lte: at } },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (row) return toRate(row);
    // Sin fila configurada se usa el valor de fábrica: es preferible cobrar con
    // la tarifa publicada que fallar el cobro.
    return (
      DEFAULT_FEE_RATES.find((r) => r.method === method) ?? DEFAULT_FEE_RATES[0]
    );
  }

  /** Tarifa vigente de todos los medios, para la pantalla de ajustes. */
  async current(at: Date = new Date()): Promise<FeeRateRow[]> {
    const rows = await Promise.all(
      FEE_METHODS.map(async (method) => {
        const row = await this.prisma.platformGatewayFee.findFirst({
          where: { method, effectiveFrom: { lte: at } },
          orderBy: { effectiveFrom: 'desc' },
        });
        const rate = row
          ? toRate(row)
          : (DEFAULT_FEE_RATES.find((r) => r.method === method) as FeeRate);
        return {
          ...rate,
          id: row?.id ?? null,
          effectiveFrom: row?.effectiveFrom.toISOString() ?? null,
          note: row?.note ?? null,
        };
      }),
    );
    return rows;
  }

  /** Histórico de un medio. Append-only: nada se edita ni se borra. */
  async history(method: FeeMethod) {
    const rows = await this.prisma.platformGatewayFee.findMany({
      where: { method },
      orderBy: { effectiveFrom: 'desc' },
      take: 50,
    });
    return { rates: rows };
  }

  /** Cambiar una tarifa es INSERTAR una fila nueva, nunca un UPDATE. */
  async upsertRate(
    input: FeeRate & { effectiveFrom?: string; note?: string },
    actorUserId: string,
  ) {
    return this.prisma.platformGatewayFee.create({
      data: {
        method: input.method,
        percentBps: input.percentBps,
        fixedCOP: input.fixedCOP,
        taxBps: input.taxBps,
        retefuenteBps: input.retefuenteBps,
        reteIcaBps: input.reteIcaBps,
        reteIvaBps: input.reteIvaBps,
        settlementDays: input.settlementDays,
        effectiveFrom: input.effectiveFrom
          ? new Date(input.effectiveFrom)
          : new Date(),
        note: input.note,
        createdBy: actorUserId,
      },
    });
  }

  /**
   * Simulador: el mismo monto por todos los medios, para comparar de un vistazo
   * cuánto llega y cuánto cuesta cada uno.
   */
  async simulate(
    amountCOP: number,
    saleIvaBps = 0,
    at: Date = new Date(),
  ): Promise<{ amount: number; saleIvaBps: number; quotes: FeeQuote[] }> {
    const quotes = await Promise.all(
      FEE_METHODS.map(async (method) =>
        quoteFee({
          amountCOP,
          rate: await this.rateAt(method, at),
          saleIvaBps,
        }),
      ),
    );
    return { amount: amountCOP, saleIvaBps, quotes };
  }

  /** Siembra las tarifas publicadas si la tabla está vacía. Idempotente. */
  async seedMissing(): Promise<number> {
    let created = 0;
    for (const rate of DEFAULT_FEE_RATES) {
      const exists = await this.prisma.platformGatewayFee.count({
        where: { method: rate.method },
      });
      if (exists > 0) continue;
      await this.prisma.platformGatewayFee.create({
        data: {
          ...rate,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          note: 'Tarifa publicada por Wompi (valor de fábrica)',
        },
      });
      created += 1;
    }
    return created;
  }
}

function toRate(row: {
  method: string;
  percentBps: number;
  fixedCOP: number;
  taxBps: number;
  retefuenteBps: number;
  reteIcaBps: number;
  reteIvaBps: number;
  settlementDays: number;
}): FeeRate {
  return {
    method: row.method as FeeMethod,
    percentBps: row.percentBps,
    fixedCOP: row.fixedCOP,
    taxBps: row.taxBps,
    retefuenteBps: row.retefuenteBps,
    reteIcaBps: row.reteIcaBps,
    reteIvaBps: row.reteIvaBps,
    settlementDays: row.settlementDays,
  };
}
