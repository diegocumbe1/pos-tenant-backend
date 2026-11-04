import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlanFeaturesService } from './plan-features.service';

/**
 * Valores vigentes de cada plan para la landing pública (sin auth).
 *
 * Existe para que la web comercial diga lo mismo que aplica el sistema: si el
 * super-admin sube el cupo de Lynko de Pro a 150, la página de precios lo dice
 * sin desplegar. Solo expone los valores de los planes, nada de los negocios.
 */
@ApiTags('PublicPricing')
@Controller('public/plan-features')
export class PublicPlanFeaturesController {
  constructor(private readonly planFeatures: PlanFeaturesService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'Current feature values and limits per plan (public)' })
  getPlans() {
    return this.planFeatures.publicPlans();
  }
}
