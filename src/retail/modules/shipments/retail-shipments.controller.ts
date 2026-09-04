import {
  Body,
  Controller,
  Delete,
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
import { RetailShipmentStatus } from '@prisma/client';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import {
  AddSalesToShipmentDto,
  AddShipmentAttachmentDto,
  CancelRetailShipmentDto,
  CreateRetailShipmentDto,
  ShipRetailShipmentDto,
  UpdateRetailShipmentDto,
  UpdateShipmentAttachmentDto,
} from './dto/retail-shipment.dto';
import { RetailShipmentsService } from './retail-shipments.service';

/** Un estado inválido se ignora (= sin filtro) en vez de tumbar la petición. */
function parseStatus(value?: string): RetailShipmentStatus | undefined {
  return value === 'DRAFT' ||
    value === 'SENT' ||
    value === 'DELIVERED' ||
    value === 'CANCELLED'
    ? value
    : undefined;
}

/**
 * Envíos de tienda. Cuelga de los permisos de ventas y no de unos propios: un
 * envío es la entrega de unas ventas, y quien puede entregar puede despachar.
 */
@ApiTags('Retail')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('retail/shipments')
export class RetailShipmentsController {
  constructor(private readonly shipments: RetailShipmentsService) {}

  @Get()
  @RequirePermissions('retail:sales:read')
  @ApiQuery({ name: 'status', required: false, enum: RetailShipmentStatus })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.shipments.listShipments(ctx, {
      status: parseStatus(status),
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions('retail:sales:read')
  get(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.shipments.getShipment(ctx, id);
  }

  @Post()
  @RequirePermissions('retail:sales:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateRetailShipmentDto,
  ) {
    return this.shipments.createShipment(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('retail:sales:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateRetailShipmentDto,
  ) {
    return this.shipments.updateShipment(ctx, id, dto);
  }

  @Post(':id/sales')
  @RequirePermissions('retail:sales:write')
  @HttpCode(HttpStatus.OK)
  addSales(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: AddSalesToShipmentDto,
  ) {
    return this.shipments.addSales(ctx, id, dto);
  }

  @Delete(':id/sales/:saleId')
  @RequirePermissions('retail:sales:write')
  removeSale(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('saleId') saleId: string,
  ) {
    return this.shipments.removeSale(ctx, id, saleId);
  }

  /** Despacha: aquí sale el inventario de todas las ventas del paquete. */
  @Post(':id/ship')
  @RequirePermissions('retail:sales:write')
  @HttpCode(HttpStatus.OK)
  ship(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: ShipRetailShipmentDto,
  ) {
    return this.shipments.ship(ctx, id, dto);
  }

  @Post(':id/delivered')
  @RequirePermissions('retail:sales:write')
  @HttpCode(HttpStatus.OK)
  markDelivered(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.shipments.markDelivered(ctx, id);
  }

  @Post(':id/cancel')
  @RequirePermissions('retail:sales:write')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CancelRetailShipmentDto,
  ) {
    return this.shipments.cancelShipment(ctx, id, dto);
  }

  @Post(':id/attachments')
  @RequirePermissions('retail:sales:write')
  @HttpCode(HttpStatus.OK)
  addAttachment(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: AddShipmentAttachmentDto,
  ) {
    return this.shipments.addAttachment(ctx, id, dto);
  }

  @Patch(':id/attachments/:attachmentId')
  @RequirePermissions('retail:sales:write')
  updateAttachment(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Body() dto: UpdateShipmentAttachmentDto,
  ) {
    return this.shipments.updateAttachment(ctx, id, attachmentId, dto);
  }

  @Delete(':id/attachments/:attachmentId')
  @RequirePermissions('retail:sales:write')
  removeAttachment(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.shipments.removeAttachment(ctx, id, attachmentId);
  }
}
