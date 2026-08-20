import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { RetailDeliveryStatus, RetailSaleType } from '@prisma/client';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import {
  CreateRetailSaleDto,
  DeliverRetailSaleDto,
  VoidRetailSaleDto,
} from './dto/retail-sale.dto';
import { RetailSalesService } from './retail-sales.service';

/**
 * El query param llega como string suelto. Un valor basura se ignora (= sin
 * filtro) en vez de tumbar la petición: es un filtro de reporte, no un dato de
 * la venta, y romper el histórico de finanzas por un parámetro mal escrito en
 * la URL sería peor que mostrarlo completo.
 */
function parseSaleType(value?: string): RetailSaleType | undefined {
  return value === 'RETAIL' || value === 'WHOLESALE' ? value : undefined;
}

function parseDeliveryStatus(value?: string): RetailDeliveryStatus | undefined {
  return value === 'DELIVERED' || value === 'PENDING' ? value : undefined;
}

@ApiTags('Retail')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('retail/sales')
export class RetailSalesController {
  constructor(private readonly sales: RetailSalesService) {}

  @Get()
  @RequirePermissions('retail:sales:read')
  @ApiQuery({ name: 'from', required: false, description: 'ISO date' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'saleType', required: false, enum: RetailSaleType })
  @ApiQuery({
    name: 'deliveryStatus',
    required: false,
    enum: RetailDeliveryStatus,
  })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('saleType') saleType?: RetailSaleType,
    @Query('deliveryStatus') deliveryStatus?: RetailDeliveryStatus,
  ) {
    return this.sales.listSales(ctx, {
      from,
      to,
      limit: limit ? Number(limit) : undefined,
      saleType: parseSaleType(saleType),
      deliveryStatus: parseDeliveryStatus(deliveryStatus),
    });
  }

  @Get('summary')
  @RequirePermissions('retail:sales:read')
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'saleType', required: false, enum: RetailSaleType })
  summary(
    @CurrentTenant() ctx: TenantContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('saleType') saleType?: RetailSaleType,
  ) {
    return this.sales.getSummary(ctx, from, to, parseSaleType(saleType));
  }

  @Get(':id')
  @RequirePermissions('retail:sales:read')
  detail(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.sales.getSale(ctx, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('retail:sales:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateRetailSaleDto,
  ) {
    return this.sales.createSale(ctx, dto);
  }

  /**
   * Cierra una entrega pendiente.
   *
   * Va con permiso de escritura de ventas y no con el de anular: entregar lo que
   * ya se cobró es trabajo de mostrador, no una corrección que deba quedar
   * reservada al admin.
   */
  @Post(':id/deliver')
  @RequirePermissions('retail:sales:write')
  deliver(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: DeliverRetailSaleDto,
  ) {
    return this.sales.deliverSale(ctx, id, dto);
  }

  @Post(':id/void')
  @RequirePermissions('retail:sales:void')
  void(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: VoidRetailSaleDto,
  ) {
    return this.sales.voidSale(ctx, id, dto);
  }
}
