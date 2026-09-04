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
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import {
  CreateRetailSupplierDto,
  CreateSupplierLedgerEntryDto,
  UpdateRetailSupplierDto,
} from './dto/retail-supplier.dto';
import { RetailSuppliersService } from './retail-suppliers.service';

/**
 * Proveedores y su cuenta corriente.
 *
 * Cuelga de los permisos de inventario y no de unos propios: el proveedor es
 * parte del flujo de compras, y quien puede registrar que llegó mercancía es
 * quien tiene que poder ver a quién se le debe.
 */
@ApiTags('Retail')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('retail/suppliers')
export class RetailSuppliersController {
  constructor(private readonly suppliers: RetailSuppliersService) {}

  @Get()
  @RequirePermissions('retail:inventory:read')
  @ApiQuery({
    name: 'balance',
    required: false,
    description: 'false para omitir el saldo y traer solo las fichas.',
  })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query('balance') balance?: string,
  ) {
    return this.suppliers.list(ctx, balance !== 'false');
  }

  @Get(':id')
  @RequirePermissions('retail:inventory:read')
  get(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.suppliers.get(ctx, id);
  }

  /** El extracto: cada movimiento con el saldo que iba quedando. */
  @Get(':id/ledger')
  @RequirePermissions('retail:inventory:read')
  @ApiQuery({ name: 'limit', required: false, type: Number })
  ledger(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.suppliers.listLedger(
      ctx,
      id,
      limit ? Number(limit) : undefined,
    );
  }

  @Post()
  @RequirePermissions('retail:inventory:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateRetailSupplierDto,
  ) {
    return this.suppliers.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('retail:inventory:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateRetailSupplierDto,
  ) {
    return this.suppliers.update(ctx, id, dto);
  }

  /** Nota crédito, o el saldo que se traía de antes de llevar la cuenta. */
  @Post(':id/ledger')
  @RequirePermissions('retail:inventory:write')
  @HttpCode(HttpStatus.OK)
  addLedgerEntry(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CreateSupplierLedgerEntryDto,
  ) {
    return this.suppliers.addLedgerEntry(ctx, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('retail:inventory:write')
  remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.suppliers.remove(ctx, id);
  }
}
