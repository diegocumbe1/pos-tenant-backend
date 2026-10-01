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
import { BarberServiceCategoriesService } from './barber-service-categories.service';
import {
  CreateBarberServiceCategoryDto,
  UpdateBarberServiceCategoryDto,
} from './dto/barber-service-category.dto';

@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('barber/service-categories')
export class BarberServiceCategoriesController {
  constructor(private readonly categories: BarberServiceCategoriesService) {}

  @Get()
  @RequirePermissions('barber:services:read')
  list(@CurrentTenant() ctx: TenantContext) {
    return this.categories.list(ctx);
  }

  @Post()
  @RequirePermissions('barber:services:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateBarberServiceCategoryDto,
  ) {
    return this.categories.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('barber:services:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateBarberServiceCategoryDto,
  ) {
    return this.categories.update(ctx, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('barber:services:write')
  remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.categories.remove(ctx, id);
  }
}
