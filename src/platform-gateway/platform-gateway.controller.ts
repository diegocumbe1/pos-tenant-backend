import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/types/tenant-context.interface';
import { PlatformActor } from '../platform/decorators/platform-actor.decorator';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard';
import {
  CreateChargeDto,
  SimulateFeeDto,
  UpdateGatewaySettingsDto,
  UpsertFeeRateDto,
} from './dto/platform-gateway.dto';
import { FeeMethod } from './fee-calculator';
import { FeeRatesService } from './services/fee-rates.service';
import { ChargesService } from './services/charges.service';
import { GatewaySettingsService } from './services/gateway-settings.service';
import { WompiClient } from './services/wompi.client';

/**
 * Pasarela de pagos de la plataforma. Guards: JwtAuthGuard → PlatformAdminGuard.
 * NO usa TenantGuard ni X-Tenant-Id: esto es plata de Lynko, no del tenant.
 *
 * El webhook de Wompi NO vive aquí: tiene que ser público (Wompi no manda
 * bearer) y se autentica por checksum. Va en su propio controller cuando se
 * implemente el paso 6 de docs/PLAN_PASARELA_WOMPI.md.
 */
@ApiTags('Platform Gateway')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform')
export class PlatformGatewayController {
  constructor(
    private readonly settings: GatewaySettingsService,
    private readonly wompi: WompiClient,
    private readonly charges: ChargesService,
    private readonly rates: FeeRatesService,
  ) {}

  @Get('gateway/settings')
  @ApiOperation({ summary: 'Config de la pasarela (sin secretos en claro)' })
  getSettings() {
    return this.settings.getPublic();
  }

  @Patch('gateway/settings')
  @ApiOperation({
    summary: 'Actualiza la config; secretos vacíos = no se tocan',
  })
  updateSettings(@Body() dto: UpdateGatewaySettingsDto) {
    return this.settings.update(dto);
  }

  @Post('gateway/test')
  @ApiOperation({
    summary: 'Verifica llaves contra Wompi y devuelve el comercio',
  })
  test() {
    return this.wompi.testConnection();
  }

  // ─── Tarifas por medio de pago ──────────────────────────────────────────────

  @Get('gateway/fees')
  @ApiOperation({
    summary: 'Tarifa vigente de cada medio (comisión + retenciones)',
  })
  fees() {
    return this.rates.current();
  }

  @Get('gateway/fees/:method/history')
  @ApiOperation({ summary: 'Histórico de una tarifa. Append-only.' })
  feeHistory(@Param('method') method: string) {
    return this.rates.history(method as FeeMethod);
  }

  @Post('gateway/fees')
  @ApiOperation({
    summary:
      'Guarda una tarifa nueva con fecha efectiva (no reescribe el pasado)',
  })
  saveFee(
    @Body() dto: UpsertFeeRateDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.rates.upsertRate(dto, actor.id);
  }

  @Post('gateway/fees/simulate')
  @ApiOperation({
    summary: 'Cuánto llega y cuánto cuesta un monto por cada medio de pago',
  })
  simulate(@Body() dto: SimulateFeeDto) {
    return this.rates.simulate(dto.amount, dto.saleIvaBps ?? 0);
  }

  // ─── Bitácora de eventos ────────────────────────────────────────────────────

  @Get('gateway/events')
  @ApiOperation({
    summary: 'Últimos avisos de la pasarela, incluidos los rechazados',
  })
  @ApiQuery({ name: 'limit', required: false })
  events(@Query('limit') limit?: string) {
    return this.charges.listEvents(limit ? Number(limit) : undefined);
  }

  // ─── Cobros ─────────────────────────────────────────────────────────────────

  @Get('tenants/:id/charges')
  listCharges(@Param('id') tenantId: string) {
    return this.charges.list(tenantId);
  }

  @Get('tenants/:id/charges/quote')
  @ApiOperation({
    summary: 'Cuánto cobrarle por N meses: lista, descuentos y total',
  })
  @ApiQuery({ name: 'termMonths', required: false, example: 6 })
  quoteCharge(
    @Param('id') tenantId: string,
    @Query('termMonths') termMonths?: string,
  ) {
    return this.charges.quote(tenantId, Number(termMonths) || 1);
  }

  @Post('tenants/:id/charges')
  @ApiOperation({ summary: 'Crea el cobro y devuelve el link de pago' })
  createCharge(
    @Param('id') tenantId: string,
    @Body() dto: CreateChargeDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.charges.create(tenantId, dto, actor.id);
  }

  @Post('charges/:id/verify')
  @ApiOperation({
    summary: 'Le pregunta a Wompi por este cobro (si el webhook no llegó)',
  })
  verifyCharge(@Param('id') chargeId: string) {
    return this.charges.verify(chargeId);
  }

  @Post('charges/:id/cancel')
  cancelCharge(@Param('id') chargeId: string) {
    return this.charges.cancel(chargeId);
  }
}
