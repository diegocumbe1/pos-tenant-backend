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
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { CreateIngredientDto, UpdateIngredientDto } from './dto/ingredient.dto';
import { UpsertRecipeLineDto } from './dto/recipe-line.dto';
import { CreateStockMovementDto } from './dto/stock-movement.dto';
import { InventoryService } from './inventory.service';

@ApiTags('Inventory')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('restaurant')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('ingredients')
  findIngredients(@CurrentTenant() ctx: TenantContext) {
    return this.inventoryService.findIngredients(ctx);
  }

  @Post('ingredients')
  @HttpCode(HttpStatus.CREATED)
  createIngredient(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateIngredientDto,
  ) {
    return this.inventoryService.createIngredient(ctx, dto);
  }

  @Patch('ingredients/:id')
  updateIngredient(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateIngredientDto,
  ) {
    return this.inventoryService.updateIngredient(ctx, id, dto);
  }

  @Delete('ingredients/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeIngredient(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    return this.inventoryService.removeIngredient(ctx, id);
  }

  @Get('inventory/movements')
  @ApiQuery({ name: 'ingredientId', required: false })
  @ApiQuery({ name: 'type', required: false })
  findMovements(
    @CurrentTenant() ctx: TenantContext,
    @Query('ingredientId') ingredientId?: string,
    @Query('type') type?: string,
  ) {
    return this.inventoryService.findMovements(ctx, { ingredientId, type });
  }

  @Post('inventory/movements')
  @HttpCode(HttpStatus.CREATED)
  createMovement(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateStockMovementDto,
  ) {
    return this.inventoryService.createMovement(ctx, dto);
  }

  @Get('inventory/alerts')
  alerts(@CurrentTenant() ctx: TenantContext) {
    return this.inventoryService.alerts(ctx);
  }

  @Get('products/:id/recipe')
  getRecipe(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.inventoryService.getRecipe(ctx, id);
  }

  @Post('recipes/lines')
  @HttpCode(HttpStatus.CREATED)
  upsertRecipeLine(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: UpsertRecipeLineDto,
  ) {
    return this.inventoryService.upsertRecipeLine(ctx, dto);
  }

  @Delete('recipes/lines/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeRecipeLine(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    return this.inventoryService.removeRecipeLine(ctx, id);
  }

  @Get('products/:id/cost')
  productCost(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.inventoryService.productCost(ctx, id);
  }

  @Get('products/costs')
  productCosts(@CurrentTenant() ctx: TenantContext) {
    return this.inventoryService.productCosts(ctx);
  }
}
