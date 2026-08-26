import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { RetailPurchaseStatus } from '@prisma/client';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { RetailPurchasesService } from './retail-purchases.service';
import {
  CreateRetailPurchaseItemDto,
  LinkPurchaseExpenseDto,
  ReceiveRetailPurchaseItemDto,
  UpdateRetailPurchaseItemDto,
} from './dto/retail-purchases.dto';

/**
 * Reusa los permisos de inventario: quien repone la tienda es quien apunta y
 * marca lo que hay que pedir. Un permiso propio obligaría a re-sembrar la matriz
 * de roles sin separar responsabilidades reales.
 */
@ApiTags('Retail')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('retail/purchases')
export class RetailPurchasesController {
  constructor(private readonly purchases: RetailPurchasesService) {}

  @Get()
  @RequirePermissions('retail:inventory:read')
  @ApiQuery({ name: 'status', required: false, enum: RetailPurchaseStatus })
  @ApiQuery({
    name: 'open',
    required: false,
    type: Boolean,
    description: 'Solo lo que falta atender (por pedir + pedido)',
  })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query('status') status?: RetailPurchaseStatus,
    @Query('open') open?: string,
  ) {
    return this.purchases.list(ctx, { status, open: open === 'true' });
  }

  @Get('summary')
  @RequirePermissions('retail:inventory:read')
  summary(@CurrentTenant() ctx: TenantContext) {
    return this.purchases.getSummary(ctx);
  }

  @Post()
  @RequirePermissions('retail:inventory:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateRetailPurchaseItemDto,
  ) {
    return this.purchases.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('retail:inventory:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateRetailPurchaseItemDto,
  ) {
    return this.purchases.update(ctx, id, dto);
  }

  /**
   * Agrega un pago al pedido. Se llama una vez por giro: al abonar y al
   * completar. No reemplaza los enlaces anteriores.
   */
  @Post(':id/expenses')
  @RequirePermissions('retail:inventory:write')
  linkExpense(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: LinkPurchaseExpenseDto,
  ) {
    return this.purchases.linkExpense(ctx, id, dto);
  }

  /** Corrige a qué pedido se atribuyó un pago. El gasto sigue en Finanzas. */
  @Delete(':id/expenses/:expenseId')
  @RequirePermissions('retail:inventory:write')
  unlinkExpense(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('expenseId') expenseId: string,
  ) {
    return this.purchases.unlinkExpense(ctx, id, expenseId);
  }

  @Post(':id/ordered')
  @RequirePermissions('retail:inventory:write')
  markOrdered(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.purchases.setOrdered(ctx, id, true);
  }

  @Delete(':id/ordered')
  @RequirePermissions('retail:inventory:write')
  unmarkOrdered(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.purchases.setOrdered(ctx, id, false);
  }

  @Post(':id/received')
  @RequirePermissions('retail:inventory:write')
  markReceived(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: ReceiveRetailPurchaseItemDto,
  ) {
    return this.purchases.receive(ctx, id, dto);
  }

  @Post(':id/cancel')
  @RequirePermissions('retail:inventory:write')
  cancel(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.purchases.cancel(ctx, id);
  }

  @Post(':id/reopen')
  @RequirePermissions('retail:inventory:write')
  reopen(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.purchases.reopen(ctx, id);
  }

  @Delete(':id')
  @RequirePermissions('retail:inventory:write')
  remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.purchases.remove(ctx, id);
  }
}
