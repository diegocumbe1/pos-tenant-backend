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
import { BarberServicesService } from './barber-services.service';
import {
  CreateBarberServiceDto,
  UpdateBarberServiceDto,
} from './dto/barber-service.dto';

@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('barber/services')
export class BarberServicesController {
  constructor(private readonly servicesService: BarberServicesService) {}

  @Get()
  @RequirePermissions('barber:services:read')
  list(@CurrentTenant() ctx: TenantContext) {
    return this.servicesService.listServices(ctx);
  }

  @Post()
  @RequirePermissions('barber:services:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateBarberServiceDto,
  ) {
    return this.servicesService.createService(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('barber:services:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateBarberServiceDto,
  ) {
    return this.servicesService.updateService(ctx, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('barber:services:write')
  remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.servicesService.deleteService(ctx, id);
  }
}
