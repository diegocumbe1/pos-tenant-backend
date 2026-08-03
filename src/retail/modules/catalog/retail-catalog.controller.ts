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
import { RetailCatalogService } from './retail-catalog.service';
import {
  CreateRetailCategoryDto,
  CreateRetailProductDto,
  UpdateRetailCategoryDto,
  UpdateRetailProductDto,
} from './dto/retail-catalog.dto';

@ApiTags('Retail')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('retail/categories')
export class RetailCategoriesController {
  constructor(private readonly catalog: RetailCatalogService) {}

  @Get()
  @RequirePermissions('retail:catalog:read')
  list(@CurrentTenant() ctx: TenantContext) {
    return this.catalog.listCategories(ctx);
  }

  @Post()
  @RequirePermissions('retail:catalog:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateRetailCategoryDto,
  ) {
    return this.catalog.createCategory(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('retail:catalog:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateRetailCategoryDto,
  ) {
    return this.catalog.updateCategory(ctx, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('retail:catalog:delete')
  remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.catalog.deleteCategory(ctx, id);
  }
}

@ApiTags('Retail')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('retail/products')
export class RetailProductsController {
  constructor(private readonly catalog: RetailCatalogService) {}

  @Get()
  @RequirePermissions('retail:catalog:read')
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'lowStock', required: false, type: Boolean })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query('categoryId') categoryId?: string,
    @Query('search') search?: string,
    @Query('lowStock') lowStock?: string,
  ) {
    return this.catalog.listProducts(ctx, {
      categoryId,
      search,
      lowStock: lowStock === 'true',
    });
  }

  @Get('barcode/:barcode')
  @RequirePermissions('retail:catalog:read')
  byBarcode(
    @CurrentTenant() ctx: TenantContext,
    @Param('barcode') barcode: string,
  ) {
    return this.catalog.findByBarcode(ctx, barcode);
  }

  @Post()
  @RequirePermissions('retail:catalog:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateRetailProductDto,
  ) {
    return this.catalog.createProduct(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('retail:catalog:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateRetailProductDto,
  ) {
    return this.catalog.updateProduct(ctx, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('retail:catalog:delete')
  remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.catalog.deleteProduct(ctx, id);
  }
}
