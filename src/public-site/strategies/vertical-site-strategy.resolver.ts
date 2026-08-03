import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BarberSiteStrategy } from './barber-site.strategy';
import { RetailSiteStrategy } from './retail-site.strategy';
import { VerticalSiteStrategy } from './vertical-site-strategy';

/**
 * Resolves which {@link VerticalSiteStrategy} drives the public-site builder for
 * a given tenant, based on its BusinessVertical. Verticals without a registered
 * strategy do not expose a public site.
 */
@Injectable()
export class VerticalSiteStrategyResolver {
  private readonly byCode: Map<string, VerticalSiteStrategy>;

  constructor(
    private readonly prisma: PrismaService,
    barber: BarberSiteStrategy,
    retail: RetailSiteStrategy,
  ) {
    this.byCode = new Map(
      [barber, retail].map((strategy) => [strategy.verticalCode, strategy]),
    );
  }

  /** Whether the given vertical code has a public-site strategy. */
  supports(code?: string | null): boolean {
    return Boolean(code) && this.byCode.has(code as string);
  }

  /**
   * Tipos de sección que la vertical no renderiza. Lookup síncrono por código
   * para poder filtrar al armar el payload, sin resolver el tenant otra vez.
   */
  unsupportedSectionTypes(code?: string | null): Set<string> {
    const strategy = code ? this.byCode.get(code) : undefined;
    return strategy?.unsupportedSectionTypes() ?? new Set<string>();
  }

  /** Resolve the strategy for a tenant, throwing if its vertical is unsupported. */
  async resolveForTenant(tenantId: string): Promise<VerticalSiteStrategy> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { vertical: { select: { code: true } } },
    });
    const code = tenant?.vertical?.code;
    const strategy = code ? this.byCode.get(code) : undefined;
    if (!strategy) {
      throw new BadRequestException(
        'Tenant vertical does not support a public site',
      );
    }
    return strategy;
  }
}
