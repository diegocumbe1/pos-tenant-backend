import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Product } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateIngredientDto, UpdateIngredientDto } from './dto/ingredient.dto';
import {
  CreateStockMovementDto,
  STOCK_MOVEMENT_TYPES,
} from './dto/stock-movement.dto';
import { UpsertRecipeLineDto } from './dto/recipe-line.dto';
import {
  assertCompatibleUnits,
  convertQuantity,
  isPhysicallyConvertible,
  type ConversionCtx,
} from './unit-conversion';

type IngredientRow = Prisma.IngredientGetPayload<Record<string, never>>;
type RecipeLineRow = Prisma.RecipeLineGetPayload<{
  include: { ingredient: true };
}>;

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async findIngredients(ctx: TenantContext) {
    const ingredients = await this.prisma.ingredient.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });

    return {
      ingredients: ingredients.map((item) => this.toIngredientDto(item)),
    };
  }

  async createIngredient(ctx: TenantContext, dto: CreateIngredientDto) {
    const purchaseUnit = dto.purchaseUnit;
    const recipeUnit = dto.recipeUnit || dto.unit || dto.purchaseUnit;
    const initialStock = dto.grossStockQuantity ?? dto.currentStock ?? 0;
    const totalPurchaseCost = dto.totalPurchaseCost ?? 0;
    const technicalWastePercentage = dto.technicalWastePercentage ?? 0;
    // El factor solo es relevante cuando NO hay conversión física (ej: paquete→unidad).
    const purchaseToRecipeFactor = isPhysicallyConvertible(
      purchaseUnit,
      recipeUnit,
    )
      ? null
      : (dto.purchaseToRecipeFactor ?? null);

    this.assertWaste(technicalWastePercentage);
    assertCompatibleUnits(purchaseUnit, recipeUnit, purchaseToRecipeFactor);

    const metrics = this.calculateMetrics({
      grossStockQuantity: initialStock,
      purchaseUnit,
      recipeUnit,
      purchaseToRecipeFactor,
      technicalWastePercentage,
      totalPurchaseCost,
    });

    const ingredient = await this.prisma.$transaction(async (tx) => {
      const created = await tx.ingredient.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          categoryId: dto.categoryId,
          name: dto.name,
          purchaseUnit,
          recipeUnit,
          purchaseToRecipeFactor,
          grossStockQuantity: initialStock,
          currentStock: initialStock,
          netUsableQuantity: metrics.netUsableQuantity,
          technicalWastePercentage,
          totalPurchaseCost,
          grossUnitCost: metrics.grossUnitCost,
          netUnitCost: metrics.netUnitCost,
          minStock: dto.minStock,
          supplierName: dto.supplierName,
          expirationDate: dto.expirationDate
            ? new Date(dto.expirationDate)
            : undefined,
          notes: dto.notes,
        },
      });

      if (initialStock > 0) {
        await tx.stockMovement.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            ingredientId: created.id,
            type: 'PURCHASE',
            quantity: initialStock,
            unitCost:
              initialStock > 0 && totalPurchaseCost > 0
                ? totalPurchaseCost / initialStock
                : undefined,
            previousStock: 0,
            newStock: initialStock,
            notes: 'Initial stock',
            createdBy: ctx.userId,
            createdByName: ctx.name,
          },
        });
      }

      return created;
    });

    return this.toIngredientDto(ingredient);
  }

  async updateIngredient(
    ctx: TenantContext,
    id: string,
    dto: UpdateIngredientDto,
  ) {
    const current = await this.assertIngredient(ctx, id);
    const purchaseUnit = dto.purchaseUnit ?? current.purchaseUnit;
    const recipeUnit = dto.recipeUnit ?? dto.unit ?? current.recipeUnit;
    const technicalWastePercentage =
      dto.technicalWastePercentage ?? current.technicalWastePercentage;
    const totalPurchaseCost =
      dto.totalPurchaseCost ?? current.totalPurchaseCost;
    const purchaseToRecipeFactor = isPhysicallyConvertible(
      purchaseUnit,
      recipeUnit,
    )
      ? null
      : (dto.purchaseToRecipeFactor ??
        current.purchaseToRecipeFactor ??
        null);

    this.assertWaste(technicalWastePercentage);
    assertCompatibleUnits(purchaseUnit, recipeUnit, purchaseToRecipeFactor);

    const metrics = this.calculateMetrics({
      grossStockQuantity: current.currentStock,
      purchaseUnit,
      recipeUnit,
      purchaseToRecipeFactor,
      technicalWastePercentage,
      totalPurchaseCost,
    });

    const updated = await this.prisma.ingredient.update({
      where: { id },
      data: {
        categoryId: dto.categoryId,
        name: dto.name,
        purchaseUnit: dto.purchaseUnit,
        recipeUnit: dto.recipeUnit ?? dto.unit,
        purchaseToRecipeFactor,
        technicalWastePercentage: dto.technicalWastePercentage,
        totalPurchaseCost: dto.totalPurchaseCost,
        grossStockQuantity: current.currentStock,
        netUsableQuantity: metrics.netUsableQuantity,
        grossUnitCost: metrics.grossUnitCost,
        netUnitCost: metrics.netUnitCost,
        minStock: dto.minStock,
        supplierName: dto.supplierName,
        expirationDate: dto.expirationDate
          ? new Date(dto.expirationDate)
          : dto.expirationDate === null
            ? null
            : undefined,
        notes: dto.notes,
        isActive: dto.isActive,
      },
    });

    return this.toIngredientDto(updated);
  }

  async removeIngredient(ctx: TenantContext, id: string) {
    await this.assertIngredient(ctx, id);
    await this.prisma.ingredient.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async findMovements(
    ctx: TenantContext,
    query: { ingredientId?: string; type?: string },
  ) {
    const movements = await this.prisma.stockMovement.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        ingredientId: query.ingredientId,
        type: query.type,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return { movements };
  }

  async createMovement(ctx: TenantContext, dto: CreateStockMovementDto) {
    if (!STOCK_MOVEMENT_TYPES.includes(dto.type as any)) {
      throw new BadRequestException(`Invalid movement type: ${dto.type}`);
    }

    if (dto.quantity === 0) {
      throw new BadRequestException('Movement quantity cannot be 0');
    }

    const ingredient = await this.assertIngredient(ctx, dto.ingredientId);
    const previousStock = ingredient.currentStock;
    const newStock = previousStock + dto.quantity;

    if (newStock < 0) {
      throw new BadRequestException('Movement would make stock negative');
    }

    const totalPurchaseCost =
      dto.type === 'PURCHASE' && dto.unitCost !== undefined
        ? ingredient.totalPurchaseCost + dto.quantity * dto.unitCost
        : ingredient.totalPurchaseCost;

    const metrics = this.calculateMetrics({
      grossStockQuantity: newStock,
      purchaseUnit: ingredient.purchaseUnit,
      recipeUnit: ingredient.recipeUnit,
      purchaseToRecipeFactor: ingredient.purchaseToRecipeFactor,
      technicalWastePercentage: ingredient.technicalWastePercentage,
      totalPurchaseCost,
    });

    const movement = await this.prisma.$transaction(async (tx) => {
      const created = await tx.stockMovement.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          ingredientId: ingredient.id,
          type: dto.type,
          quantity: dto.quantity,
          unitCost: dto.unitCost,
          previousStock,
          newStock,
          orderId: dto.orderId,
          notes: dto.notes,
          createdBy: ctx.userId,
          createdByName: ctx.name,
        },
      });

      await tx.ingredient.update({
        where: { id: ingredient.id },
        data: {
          currentStock: newStock,
          grossStockQuantity: newStock,
          netUsableQuantity: metrics.netUsableQuantity,
          totalPurchaseCost,
          grossUnitCost: metrics.grossUnitCost,
          netUnitCost: metrics.netUnitCost,
        },
      });

      return created;
    });

    return movement;
  }

  async alerts(ctx: TenantContext) {
    const ingredients = await this.prisma.ingredient.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        isActive: true,
        currentStock: { lte: this.prisma.ingredient.fields.minStock },
      },
      orderBy: { name: 'asc' },
    });

    return { alerts: ingredients.map((item) => this.toIngredientDto(item)) };
  }

  async getRecipe(ctx: TenantContext, productId: string) {
    await this.assertProduct(ctx, productId);
    const lines = await this.prisma.recipeLine.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId, productId },
      include: { ingredient: true },
      orderBy: { createdAt: 'asc' },
    });

    return { recipeLines: lines.map((line) => this.toRecipeLineDto(line)) };
  }

  async upsertRecipeLine(ctx: TenantContext, dto: UpsertRecipeLineDto) {
    await this.assertProduct(ctx, dto.productId);
    const ingredient = await this.assertIngredient(ctx, dto.ingredientId);
    assertCompatibleUnits(
      dto.unit,
      ingredient.recipeUnit,
      ingredient.purchaseToRecipeFactor,
    );

    const line = await this.prisma.recipeLine.upsert({
      where: {
        productId_ingredientId: {
          productId: dto.productId,
          ingredientId: dto.ingredientId,
        },
      },
      update: {
        quantity: dto.quantity,
        unit: dto.unit,
      },
      create: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        productId: dto.productId,
        ingredientId: dto.ingredientId,
        quantity: dto.quantity,
        unit: dto.unit,
      },
      include: { ingredient: true },
    });

    return this.toRecipeLineDto(line);
  }

  async removeRecipeLine(ctx: TenantContext, id: string) {
    const line = await this.prisma.recipeLine.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: { id: true },
    });

    if (!line) throw new NotFoundException(`Recipe line ${id} not found`);
    await this.prisma.recipeLine.delete({ where: { id } });
  }

  async productCost(ctx: TenantContext, productId: string) {
    const product = await this.assertProduct(ctx, productId);
    const lines = await this.prisma.recipeLine.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId, productId },
      include: { ingredient: true },
    });

    return this.toProductCost(product, lines);
  }

  async productCosts(ctx: TenantContext) {
    const products = await this.prisma.product.findMany({
      where: {
        tenantId: ctx.tenantId,
        deletedAt: null,
        OR: [{ branchId: null }, { branchId: ctx.branchId }],
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    const costs = await Promise.all(
      products.map((product) => this.productCost(ctx, product.id)),
    );

    return { costs };
  }

  private async assertIngredient(ctx: TenantContext, id: string) {
    const ingredient = await this.prisma.ingredient.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });

    if (!ingredient) throw new NotFoundException(`Ingredient ${id} not found`);
    return ingredient;
  }

  private async assertProduct(ctx: TenantContext, id: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId,
        deletedAt: null,
        OR: [{ branchId: null }, { branchId: ctx.branchId }],
      },
    });

    if (!product) throw new NotFoundException(`Product ${id} not found`);
    if (product.branchId && product.branchId !== ctx.branchId) {
      throw new ForbiddenException('Product does not belong to this branch');
    }

    return product;
  }

  private toIngredientDto(ingredient: IngredientRow) {
    return {
      ...ingredient,
      unit: ingredient.recipeUnit,
      costPerUnit: ingredient.netUnitCost,
    };
  }

  private toRecipeLineDto(line: RecipeLineRow) {
    const unitCost = this.convertUnitCost(
      line.ingredient.netUnitCost,
      line.ingredient.recipeUnit,
      line.unit,
      {
        purchaseUnit: line.ingredient.purchaseUnit,
        recipeUnit: line.ingredient.recipeUnit,
        purchaseToRecipeFactor: line.ingredient.purchaseToRecipeFactor,
      },
    );
    const lineCost = line.quantity * unitCost;

    return {
      id: line.id,
      tenantId: line.tenantId,
      branchId: line.branchId,
      productId: line.productId,
      ingredientId: line.ingredientId,
      quantity: line.quantity,
      unit: line.unit,
      ingredient: this.toIngredientDto(line.ingredient),
      unitCost,
      lineCost,
      createdAt: line.createdAt,
      updatedAt: line.updatedAt,
    };
  }

  private toProductCost(product: Product, lines: RecipeLineRow[]) {
    const recipeLines = lines.map((line) => this.toRecipeLineDto(line));
    const recipeCostCOP = recipeLines.reduce(
      (sum, line) => sum + line.lineCost,
      0,
    );

    const marginCOP = product.priceCOP - recipeCostCOP;
    const marginPct =
      product.priceCOP > 0 ? (marginCOP / product.priceCOP) * 100 : 0;

    return {
      productId: product.id,
      name: product.name,
      priceCOP: product.priceCOP,
      recipeCostCOP,
      marginCOP,
      marginPct,
      targetMarginPct: product.targetMarginPct,
      recipeLines,
    };
  }

  private calculateMetrics(input: {
    grossStockQuantity: number;
    purchaseUnit: string;
    recipeUnit: string;
    purchaseToRecipeFactor?: number | null;
    technicalWastePercentage: number;
    totalPurchaseCost: number;
  }) {
    if (input.grossStockQuantity < 0) {
      throw new BadRequestException('Stock cannot be negative');
    }

    const grossQuantityInRecipeUnit = convertQuantity(
      input.grossStockQuantity,
      input.purchaseUnit,
      input.recipeUnit,
      {
        purchaseUnit: input.purchaseUnit,
        recipeUnit: input.recipeUnit,
        purchaseToRecipeFactor: input.purchaseToRecipeFactor,
      },
    );
    const usableRatio = 1 - input.technicalWastePercentage / 100;
    const netUsableQuantity = grossQuantityInRecipeUnit * usableRatio;

    const grossUnitCost =
      input.grossStockQuantity > 0
        ? input.totalPurchaseCost / input.grossStockQuantity
        : 0;
    const netUnitCost =
      netUsableQuantity > 0 ? input.totalPurchaseCost / netUsableQuantity : 0;

    return {
      netUsableQuantity,
      grossUnitCost,
      netUnitCost,
    };
  }

  private assertWaste(value: number) {
    if (value < 0 || value >= 100) {
      throw new BadRequestException(
        'technicalWastePercentage must be >= 0 and < 100',
      );
    }
  }

  private convertUnitCost(
    costPerFromUnit: number,
    from: string,
    to: string,
    ctx?: ConversionCtx,
  ) {
    const oneTo = convertQuantity(1, to, from, ctx);
    return costPerFromUnit * oneTo;
  }
}
