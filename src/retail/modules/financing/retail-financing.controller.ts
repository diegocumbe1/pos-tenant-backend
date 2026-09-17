import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';

import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import {
  CreateFinancingProviderDto,
  CreateFinancingSettlementDto,
  FinancingTermsDto,
  ResolveFinancingStatusDto,
  UpdateFinancingProviderDto,
} from './dto/financing.dto';
import { RetailFinancingService } from './retail-financing.service';

@ApiTags('Retail')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('retail/financing')
export class RetailFinancingController {
  constructor(private readonly financing: RetailFinancingService) {}

  /**
   * Lo lee cualquiera que pueda vender: el POS necesita saber qué convenios
   * ofrecer y con qué comisión, y sin eso no puede mostrar cuánto recibe el
   * negocio. Configurarlos, en cambio, es de ajustes.
   */
  @Get('providers')
  @RequirePermissions('retail:sales:read')
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  listProviders(
    @CurrentTenant() ctx: TenantContext,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.financing.listProviders(ctx, {
      includeInactive: includeInactive === 'true',
    });
  }

  @Post('providers')
  @RequirePermissions('retail:settings:write')
  createProvider(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateFinancingProviderDto,
  ) {
    return this.financing.createProvider(ctx, dto);
  }

  @Patch('providers/:id')
  @RequirePermissions('retail:settings:write')
  updateProvider(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateFinancingProviderDto,
  ) {
    return this.financing.updateProvider(ctx, id, dto);
  }

  /**
   * PUT y no PATCH porque no edita nada: agrega unos términos nuevos con su
   * fecha efectiva. La fila anterior sigue ahí, intacta.
   */
  @Put('providers/:id/terms')
  @RequirePermissions('retail:settings:write')
  setTerms(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: FinancingTermsDto,
  ) {
    return this.financing.setTerms(ctx, id, dto);
  }

  /** Lo que los financiadores todavía deben. */
  @Get('pending')
  @RequirePermissions('retail:sales:read')
  @ApiQuery({ name: 'providerId', required: false })
  listPending(
    @CurrentTenant() ctx: TenantContext,
    @Query('providerId') providerId?: string,
  ) {
    return this.financing.listPending(ctx, { providerId });
  }

  @Get('settlements')
  @RequirePermissions('retail:sales:read')
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'providerId', required: false })
  listSettlements(
    @CurrentTenant() ctx: TenantContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('providerId') providerId?: string,
  ) {
    return this.financing.listSettlements(ctx, { from, to, providerId });
  }

  /**
   * Registrar un giro mueve plata: sella el ingreso del día en que llegó y
   * escribe la comisión como gasto. Por eso pide el permiso de cobrar, no el
   * de leer.
   */
  @Post('settlements')
  @RequirePermissions('retail:sales:write')
  createSettlement(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateFinancingSettlementDto,
  ) {
    return this.financing.createSettlement(ctx, dto);
  }

  /**
   * El financiador finalmente respondió una venta que quedó radicada.
   *
   * Rechazar devuelve la venta a "por cobrar", así que mueve plata: pide el
   * permiso de cobrar, no el de leer.
   */
  @Patch('sales/:saleId/status')
  @RequirePermissions('retail:sales:write')
  resolveStatus(
    @CurrentTenant() ctx: TenantContext,
    @Param('saleId') saleId: string,
    @Body() dto: ResolveFinancingStatusDto,
  ) {
    return this.financing.resolveStatus(ctx, saleId, dto);
  }
}
