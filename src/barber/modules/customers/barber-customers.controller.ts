import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { BarberCustomersService } from './barber-customers.service';
import {
  CreateBarberCustomerDto,
  UpdateBarberCustomerDto,
} from './dto/barber-customer.dto';

@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('barber/customers')
export class BarberCustomersController {
  constructor(private readonly customersService: BarberCustomersService) {}

  @Get()
  @RequirePermissions('barber:customers:read')
  list(@CurrentTenant() ctx: TenantContext) {
    return this.customersService.listCustomers(ctx);
  }

  @Post()
  @RequirePermissions('barber:customers:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateBarberCustomerDto,
  ) {
    return this.customersService.createCustomer(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('barber:customers:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateBarberCustomerDto,
  ) {
    return this.customersService.updateCustomer(ctx, id, dto);
  }

  // Borrado en cascada (cliente + sus citas). Control del dueño del tenant.
  @Delete(':id')
  @RequirePermissions('barber:customers:write')
  remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.customersService.deleteCustomer(ctx, id);
  }
}
