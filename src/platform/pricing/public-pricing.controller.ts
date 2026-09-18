import { Controller, Get, Header } from '@nestjs/common';
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
  constructor(private readonly pricing: PlanPricingService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({
    summary: 'Current plan prices per vertical, with prepay terms (public)',
  })
  getCurrentPrices() {
    // Superconjunto de la matriz mensual: incluye, por plan, cuánto queda
    // pagando 3, 6 o 12 meses. La landing no calcula el descuento por su
    // cuenta — si lo hiciera, tarde o temprano mostraría un número distinto al
    // que emite el cobro.
    return this.pricing.getTermPricingMatrixAt();
  }
}
