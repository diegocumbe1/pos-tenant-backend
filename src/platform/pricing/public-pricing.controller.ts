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
  @ApiOperation({ summary: 'Current plan prices per vertical (public)' })
  getCurrentPrices() {
    return this.pricing.getPriceMatrixAt();
  }
}
