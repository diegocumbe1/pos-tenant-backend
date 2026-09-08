import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlanPricingService } from '../platform/pricing/plan-pricing.service';

/**
 * Los servicios que se le cobran a un catálogo gestionado.
 *
 * Son cuatro y no más a propósito: cada tarifa suelta es una conversación de
 * venta que hay que sostener, y este producto se vende justamente porque cabe
 * en un mensaje de WhatsApp.
 */
export const CATALOG_SERVICE_CODES = [
  'SETUP',
  'SEASON_UPDATE',
  'YEAR_BUNDLE',
  'EXTRA_PRODUCT',
] as const;

export type CatalogServiceCode = (typeof CATALOG_SERVICE_CODES)[number];

/**
 * Tarifas de catálogo: APPEND-ONLY con fecha efectiva.
 *
 * Mismo modelo que `PlanPrice` y por la misma razón: subir el precio en
 * diciembre no puede reescribir lo que se le cobró a alguien en septiembre.
 * Guardar crea una tarifa nueva; la anterior queda en el histórico.
 *
 * El ancla es USD y el COP se deriva de la tasa vigente A LA MISMA FECHA, así
 * que consultar una tarifa vieja da los pesos que valía entonces, no los de hoy.
 */
@Injectable()
export class CatalogPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly planPricing: PlanPricingService,
  ) {}

  /** Las cuatro tarifas vigentes a una fecha, en USD y en COP. */
  async getPricesAt(at: Date = new Date()) {
    const [rows, rate] = await Promise.all([
      this.prisma.catalogServicePrice.findMany({
        where: { effectiveFrom: { lte: at } },
        orderBy: { effectiveFrom: 'asc' },
      }),
      this.planPricing.getRateAt(at),
    ]);

    // Recorrido ascendente: la última escritura por código gana, que es justo
    // la fila con `effectiveFrom` más alto <= at.
    const current = new Map<string, (typeof rows)[number]>();
    for (const row of rows) current.set(row.serviceCode, row);

    return {
      rate,
      at: at.toISOString(),
      services: CATALOG_SERVICE_CODES.map((serviceCode) => {
        const row = current.get(serviceCode);
        return {
          serviceCode,
          priceUsdCents: row?.priceUsdCents ?? null,
          priceUSD: row ? row.priceUsdCents / 100 : null,
          // Se redondea al peso: nadie cobra centavos de peso, y dejar el
          // decimal haría que la cifra del backoffice no coincida con la que el
          // superadmin le dice al cliente por WhatsApp.
          priceCOP: row ? Math.round((row.priceUsdCents / 100) * rate) : null,
          effectiveFrom: row?.effectiveFrom.toISOString() ?? null,
          note: row?.note ?? null,
        };
      }),
    };
  }

  async getHistory(serviceCode?: string) {
    const rows = await this.prisma.catalogServicePrice.findMany({
      where: serviceCode ? { serviceCode } : {},
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
    return {
      history: rows.map((row) => ({
        id: row.id,
        serviceCode: row.serviceCode,
        priceUsdCents: row.priceUsdCents,
        priceUSD: row.priceUsdCents / 100,
        effectiveFrom: row.effectiveFrom.toISOString(),
        note: row.note,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async createPrice(
    input: {
      serviceCode: string;
      priceUsdCents: number;
      effectiveFrom?: string;
      note?: string;
    },
    actorUserId: string,
  ) {
    if (
      !CATALOG_SERVICE_CODES.includes(input.serviceCode as CatalogServiceCode)
    ) {
      throw new BadRequestException(
        `Servicio desconocido: ${input.serviceCode}`,
      );
    }

    await this.prisma.catalogServicePrice.create({
      data: {
        serviceCode: input.serviceCode,
        priceUsdCents: input.priceUsdCents,
        // Sin fecha, rige desde ya. Poner una futura deja la tarifa programada
        // y `getPricesAt` no la toma hasta que llegue el día.
        effectiveFrom: input.effectiveFrom
          ? new Date(input.effectiveFrom)
          : new Date(),
        note: input.note ?? null,
        createdBy: actorUserId,
      },
    });

    return this.getPricesAt();
  }
}
