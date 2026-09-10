import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  RetailDeliveryStatus,
  RetailPaymentMethod,
  RetailPaymentStatus,
  RetailSaleType,
} from '@prisma/client';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import {
  CreateRetailSaleDto,
  CreateRetailSaleNoteDto,
  CreateRetailSalePaymentDto,
  DeliverRetailSaleDto,
  PayRetailSaleDto,
  UpdateRetailSaleCustomerDto,
  UpdateRetailSaleDateDto,
  VoidRetailSalePaymentDto,
  VoidRetailSaleDto,
} from './dto/retail-sale.dto';
import { CreateRetailSaleReturnDto } from './dto/retail-sale-return.dto';
import { RetailSaleReturnsService } from './retail-sale-returns.service';
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

/**
 * 'OPEN' no es un estado de la base: significa "todo lo que no está cobrado
 * completo". Con abonos, filtrar por 'PENDING' esconde las ventas a medio pagar,
 * que son justamente las que hay que ir a cobrar.
 */
function parsePaymentStatus(
  value?: string,
): RetailPaymentStatus | 'OPEN' | undefined {
  return value === 'PAID' ||
    value === 'PENDING' ||
    value === 'PARTIAL' ||
    value === 'OPEN'
    ? value
    : undefined;
}

/** Medio del ABONO. Un valor desconocido se ignora, igual que los demás. */
function parsePaymentMethod(value?: string): RetailPaymentMethod | undefined {
  return value === 'CASH' ||
    value === 'CARD' ||
    value === 'TRANSFER' ||
    value === 'MIXED' ||
    value === 'OTHER'
    ? value
    : undefined;
}

@ApiTags('Retail')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('retail/sales')
export class RetailSalesController {
  constructor(
    private readonly sales: RetailSalesService,
    private readonly returns: RetailSaleReturnsService,
  ) {}

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
  @ApiQuery({
    name: 'paymentStatus',
    required: false,
    enum: RetailPaymentStatus,
  })
  @ApiQuery({
    name: 'paymentMethod',
    required: false,
    enum: RetailPaymentMethod,
    description:
      'Medio del ABONO, no el anotado al cerrar la venta: devuelve las ventas ' +
      'que recibieron al menos un pago por ese medio.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description:
      'Código de la venta, nombre o teléfono del cliente, o nombre de un ' +
      'producto. "23", "rs-23" y "RS-000023" encuentran lo mismo.',
  })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('saleType') saleType?: RetailSaleType,
    @Query('deliveryStatus') deliveryStatus?: RetailDeliveryStatus,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('paymentMethod') paymentMethod?: string,
  ) {
    return this.sales.listSales(ctx, {
      from,
      to,
      limit: limit ? Number(limit) : undefined,
      saleType: parseSaleType(saleType),
      deliveryStatus: parseDeliveryStatus(deliveryStatus),
      paymentStatus: parsePaymentStatus(paymentStatus),
      paymentMethod: parsePaymentMethod(paymentMethod),
      search,
    });
  }

  @Get('summary')
  @RequirePermissions('retail:sales:read')
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'saleType', required: false, enum: RetailSaleType })
  @ApiQuery({
    name: 'paymentMethod',
    required: false,
    enum: RetailPaymentMethod,
    description:
      'Acota TODO el resumen a la plata que entró por ese medio (base abonos).',
  })
  summary(
    @CurrentTenant() ctx: TenantContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('saleType') saleType?: RetailSaleType,
    @Query('paymentMethod') paymentMethod?: string,
  ) {
    return this.sales.getSummary(
      ctx,
      from,
      to,
      parseSaleType(saleType),
      parsePaymentMethod(paymentMethod),
    );
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
   * Registra una entrega, total o parcial, de una venta pendiente.
   *
   * Va con permiso de escritura de ventas y no con el de anular: entregar lo que
   * ya se cobró es trabajo de mostrador, no una corrección reservada al admin.
   */
  @Post(':id/deliveries')
  @RequirePermissions('retail:sales:write')
  deliver(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: DeliverRetailSaleDto,
  ) {
    return this.sales.addDelivery(ctx, id, dto);
  }

  /**
   * Marca cobrada una venta fiada. A partir de aquí suma al ingreso.
   *
   * Va con escritura de ventas: recibir la plata de un fiado es trabajo de
   * mostrador, no una corrección reservada al admin.
   */
  /**
   * Las devoluciones de una venta. Van en el detalle: sin ellas, una venta con
   * mercancía devuelta se ve igual que una intacta.
   */
  @Get(':id/returns')
  @RequirePermissions('retail:sales:read')
  listReturns(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.returns.listBySale(ctx, id);
  }

  /** Devolución o cambio. NO anula la venta: es un hecho nuevo, de otro día. */
  @Post(':id/returns')
  @RequirePermissions('retail:sales:write')
  createReturn(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CreateRetailSaleReturnDto,
  ) {
    return this.returns.create(ctx, id, dto);
  }

  /**
   * Registra un abono: plata que entró por esta venta, sin que tenga que ser
   * todo el saldo.
   *
   * Va con escritura de ventas y no con el de anular: recibir un abono es
   * trabajo de mostrador, igual que cobrar.
   */
  @Post(':id/payments')
  @RequirePermissions('retail:sales:write')
  addPayment(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CreateRetailSalePaymentDto,
  ) {
    return this.sales.addPayment(ctx, id, dto);
  }

  /**
   * Anula un abono mal digitado. No lo borra: sigue en el histórico con el
   * motivo y con quién lo anuló.
   *
   * Va con el permiso de anular: deshacer plata registrada es una corrección de
   * dueño, no trabajo de mostrador.
   */
  @Post(':id/payments/:paymentId/void')
  @RequirePermissions('retail:sales:void')
  voidPayment(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() dto: VoidRetailSalePaymentDto,
  ) {
    return this.sales.voidPayment(ctx, id, paymentId, dto);
  }

  /**
   * El histórico de la venta: todo lo que le pasó, en orden, con autor y hora.
   *
   * Va aparte del detalle y no dentro de él porque solo se pide al abrirlo: la
   * bandeja lista cientos de ventas y ninguna necesita su historia para
   * dibujarse.
   */
  @Get(':id/events')
  @RequirePermissions('retail:sales:read')
  events(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.sales.listEvents(ctx, id);
  }

  /** Una anotación a mano en el histórico. No cambia ningún número. */
  @Post(':id/notes')
  @RequirePermissions('retail:sales:write')
  addNote(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CreateRetailSaleNoteDto,
  ) {
    return this.sales.addSaleNote(ctx, id, dto);
  }

  @Post(':id/pay')
  @RequirePermissions('retail:sales:write')
  pay(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: PayRetailSaleDto,
  ) {
    return this.sales.paySale(ctx, id, dto);
  }

  /**
   * Devuelve la venta a "por cobrar". Corrige un cobro registrado por error;
   * no toca inventario ni la fecha de venta.
   */
  @Post(':id/unpay')
  @RequirePermissions('retail:sales:write')
  unpay(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: PayRetailSaleDto,
  ) {
    return this.sales.unpaySale(ctx, id, dto);
  }

  /**
   * Corrige el día de la venta. Se permite aunque ya esté cobrada y entregada:
   * corregir la fecha no deshace nada, y bloquearlo al cerrar dejaría el error
   * escrito para siempre.
   *
   * Va con el permiso de anular y no con el de escritura: mueve un ingreso de un
   * día a otro, que es una corrección de dueño, no trabajo de mostrador.
   */
  @Patch(':id/date')
  @RequirePermissions('retail:sales:void')
  updateDate(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateRetailSaleDateDto,
  ) {
    return this.sales.updateSaleDate(ctx, id, dto);
  }

  /**
   * Cambia (o pone) el cliente de una venta ya registrada.
   *
   * Va con el permiso de anular, igual que corregir la fecha: reescribe el
   * histórico de compras de dos clientes, y eso es corrección de dueño, no
   * trabajo de mostrador.
   */
  @Patch(':id/customer')
  @RequirePermissions('retail:sales:void')
  updateCustomer(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateRetailSaleCustomerDto,
  ) {
    return this.sales.updateSaleCustomer(ctx, id, dto);
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
