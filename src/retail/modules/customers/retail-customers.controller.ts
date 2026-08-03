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
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import {
  CreateRetailCustomerDto,
  UpdateRetailCustomerDto,
} from './dto/retail-customer.dto';
import { RetailCustomersService } from './retail-customers.service';

@ApiTags('Retail')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('retail/customers')
export class RetailCustomersController {
  constructor(private readonly customers: RetailCustomersService) {}

  @Get()
  @RequirePermissions('retail:customers:read')
  @ApiQuery({ name: 'search', required: false })
  list(@CurrentTenant() ctx: TenantContext, @Query('search') search?: string) {
    return this.customers.listCustomers(ctx, search);
  }

  @Get(':id/sales')
  @RequirePermissions('retail:customers:read')
  sales(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.customers.getCustomerSales(ctx, id);
  }

  @Post()
  @RequirePermissions('retail:customers:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateRetailCustomerDto,
  ) {
    return this.customers.createCustomer(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('retail:customers:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateRetailCustomerDto,
  ) {
    return this.customers.updateCustomer(ctx, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('retail:customers:write')
  remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.customers.deleteCustomer(ctx, id);
  }
}
