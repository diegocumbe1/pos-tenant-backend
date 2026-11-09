import { Controller, Get, Header, Logger } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlanPricingService } from './plan-pricing.service';

/**
 * Precios vigentes para la landing pública (sin auth).
 *
 * Existe porque `/platform/plan-prices` va detrás de `PlatformAdminGuard` y la
 * landing es anónima: sin este endpoint la web comercial nunca vería los precios
 * reales y caería siempre a los valores por defecto compilados en el bundle.
 *
 * Expone SOLO la matriz vigente. El histórico de tarifas no sale nunca de aquí:
 * es información del super admin.
 */
@ApiTags('PublicPricing')
@Controller('public/plan-prices')
export class PublicPricingController {
  private readonly logger = new Logger(PublicPricingController.name);

  constructor(private readonly pricing: PlanPricingService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({
    summary: 'Current plan prices per vertical, with prepay terms (public)',
  })
  async getCurrentPrices() {
    // Superconjunto de la matriz mensual: incluye, por plan, cuánto queda
    // pagando 3, 6 o 12 meses, y el precio de cada combo de verticales. La
    // landing no calcula descuentos por su cuenta — si lo hiciera, tarde o
    // temprano mostraría un número distinto al que emite el cobro.
    const at = new Date();
    const terms = await this.pricing.getTermPricingMatrixAt(at);
    // El combo nunca debe tumbar los precios de la landing: si falla (p. ej. la
    // migración de plan_bundle_discounts aún no corrió), se publica sin combo.
    const bundle = await this.pricing
      .getBundleMatrixAt(at, terms)
      .catch((error: unknown) => {
        this.logger.warn(
          `bundle pricing unavailable: ${error instanceof Error ? error.message : error}`,
        );
        return null;
      });
    return { ...terms, bundle };
  }
}
