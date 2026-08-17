import {
  BadRequestException,
  ConflictException,
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
  ProducePreparationDto,
  UpsertPreparationComponentDto,
} from './dto/preparation.dto';
import {
  assertCompatibleUnits,
  convertQuantity,
  isPhysicallyConvertible,
  type ConversionCtx,
} from './unit-conversion';
import { convertUnitCost, recipeLineCost } from './recipe-cost';
import { valueIngredientAt } from './stock-valuation';

type IngredientRow = Prisma.IngredientGetPayload<Record<string, never>>;
type RecipeLineRow = Prisma.RecipeLineGetPayload<{
  include: { ingredient: true };
}>;

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async findIngredients(ctx: TenantContext) {
    const ingredients = await this.prisma.ingredient.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId, isActive: true },
      orderBy: [{ name: 'asc' }],
    });

    return {
      ingredients: ingredients.map((item) => this.toIngredientDto(item)),
    };
  }

  async createIngredient(ctx: TenantContext, dto: CreateIngredientDto) {
    const name = this.normalizeIngredientName(dto.name);
    await this.assertIngredientNameAvailable(ctx, name);
    await this.releaseInactiveIngredientName(ctx, name);
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
          name,
          purchaseUnit,
          recipeUnit,
          purchaseToRecipeFactor,
          isPreparation: dto.isPreparation ?? false,
          yieldQuantity: dto.yieldQuantity,
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
    const nextName =
      dto.name !== undefined ? this.normalizeIngredientName(dto.name) : undefined;
    if (nextName && nextName.toLocaleLowerCase() !== current.name.toLocaleLowerCase()) {
      await this.assertIngredientNameAvailable(ctx, nextName, id);
      await this.releaseInactiveIngredientName(ctx, nextName);
    }
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
        name: nextName,
        purchaseUnit: dto.purchaseUnit,
        recipeUnit: dto.recipeUnit ?? dto.unit,
        purchaseToRecipeFactor,
        isPreparation: dto.isPreparation,
        yieldQuantity: dto.yieldQuantity,
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
    const current = await this.assertIngredient(ctx, id);
    await this.prisma.ingredient.update({
      where: { id },
      data: {
        isActive: false,
        name: `${current.name}__deleted__${id.slice(-8)}`,
      },
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

    // Promedio ponderado móvil: solo una entrada CON precio propio mueve el
    // costo unitario. Consumos, mermas y ajustes a la baja lo dejan igual.
    const metrics = valueIngredientAt(ingredient, newStock, {
      previousStock,
      entryUnitCost:
        dto.type === 'PURCHASE' && dto.unitCost !== undefined
          ? dto.unitCost
          : null,
    });
    const totalPurchaseCost = metrics.totalPurchaseCost;

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
        wastePercent: dto.wastePercent ?? 0,
      },
      create: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        productId: dto.productId,
        ingredientId: dto.ingredientId,
        quantity: dto.quantity,
        unit: dto.unit,
        wastePercent: dto.wastePercent ?? 0,
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

  // ─── Preparaciones (sub-recetas con producción) ─────────────────────────────

  /** Devuelve la preparación con sus componentes y el costo estimado por tanda. */
  async getPreparation(ctx: TenantContext, id: string) {
    const preparation = await this.assertPreparation(ctx, id);
    const components = await this.prisma.preparationComponent.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId, preparationId: id },
      include: { component: true },
      orderBy: { createdAt: 'asc' },
    });

    const lines = components.map((line) => this.toPreparationComponentDto(line));
    const batchCost = lines.reduce((sum, line) => sum + line.lineCost, 0);

    return {
      preparation: this.toIngredientDto(preparation),
      components: lines,
      batchCost,
      // Costo por unidad de compra producida (ej: COP/kg de birria).
      unitCost:
        preparation.yieldQuantity && preparation.yieldQuantity > 0
          ? batchCost / preparation.yieldQuantity
          : 0,
    };
  }

  async upsertPreparationComponent(
    ctx: TenantContext,
    preparationId: string,
    dto: UpsertPreparationComponentDto,
  ) {
    await this.assertPreparation(ctx, preparationId);
    if (dto.componentId === preparationId) {
      throw new BadRequestException(
        'Una preparación no puede incluirse a sí misma',
      );
    }
    const component = await this.assertIngredient(ctx, dto.componentId);
    assertCompatibleUnits(
      dto.unit,
      component.recipeUnit,
      component.purchaseToRecipeFactor,
    );

    const line = await this.prisma.preparationComponent.upsert({
      where: {
        preparationId_componentId: {
          preparationId,
          componentId: dto.componentId,
        },
      },
      update: { quantity: dto.quantity, unit: dto.unit },
      create: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        preparationId,
        componentId: dto.componentId,
        quantity: dto.quantity,
        unit: dto.unit,
      },
      include: { component: true },
    });

    return this.toPreparationComponentDto(line);
  }

  async removePreparationComponent(ctx: TenantContext, id: string) {
    const line = await this.prisma.preparationComponent.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: { id: true },
    });
    if (!line) throw new NotFoundException(`Preparation component ${id} not found`);
    await this.prisma.preparationComponent.delete({ where: { id } });
  }

  /**
   * Produce N tandas: descuenta el stock de los componentes y suma el stock de la
   * preparación (costo por costeo promedio ponderado).
   */
  async producePreparation(
    ctx: TenantContext,
    id: string,
    dto: ProducePreparationDto,
  ) {
    const batches = dto.batches;
    if (!(batches > 0)) {
      throw new BadRequestException('batches debe ser mayor que 0');
    }

    return this.prisma.$transaction(async (tx) => {
      const preparation = await tx.ingredient.findFirst({
        where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      });
      if (!preparation) throw new NotFoundException(`Ingredient ${id} not found`);
      if (!preparation.isPreparation) {
        throw new BadRequestException(`${preparation.name} no es una preparación`);
      }
      if (!preparation.yieldQuantity || preparation.yieldQuantity <= 0) {
        throw new BadRequestException(
          'Define el rendimiento por tanda antes de producir',
        );
      }

      const components = await tx.preparationComponent.findMany({
        where: { tenantId: ctx.tenantId, branchId: ctx.branchId, preparationId: id },
        include: { component: true },
      });
      if (components.length === 0) {
        throw new BadRequestException(
          'La preparación no tiene componentes definidos',
        );
      }

      let batchCost = 0;

      // 1) Descontar componentes y acumular el costo de producción.
      for (const line of components) {
        const ing = line.component;
        // Cantidad requerida en la unidad de compra del componente.
        const requiredInPurchaseUnit = convertQuantity(
          line.quantity * batches,
          line.unit,
          ing.purchaseUnit,
          ing,
        );
        const newStock = ing.currentStock - requiredInPurchaseUnit;
        if (newStock < 0) {
          const round = (n: number) => Math.round(n * 10000) / 10000;
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            message: `Stock insuficiente de ${ing.name}`,
            stock: {
              ingredientId: ing.id,
              ingredientName: ing.name,
              available: round(ing.currentStock),
              requested: round(requiredInPurchaseUnit),
              unit: ing.purchaseUnit,
            },
          });
        }

        // Costo del componente usado = cantidad en unidad de receta × costo neto.
        const usedInRecipeUnit = convertQuantity(
          line.quantity * batches,
          line.unit,
          ing.recipeUnit,
          ing,
        );
        batchCost += usedInRecipeUnit * ing.netUnitCost;

        await tx.stockMovement.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            ingredientId: ing.id,
            type: 'CONSUMPTION',
            quantity: -requiredInPurchaseUnit,
            previousStock: ing.currentStock,
            newStock,
            notes: `Producción de ${preparation.name}`,
            createdBy: ctx.userId,
            createdByName: ctx.name,
          },
        });
        // Antes este update movía el stock pero NO el valor, así que
        // `totalPurchaseCost` quedaba sobrestimado y el siguiente movimiento
        // inflaba el costo unitario.
        const valuation = valueIngredientAt(ing, newStock);
        await tx.ingredient.update({
          where: { id: ing.id },
          data: {
            currentStock: newStock,
            grossStockQuantity: newStock,
            netUsableQuantity: valuation.netUsableQuantity,
            totalPurchaseCost: valuation.totalPurchaseCost,
            grossUnitCost: valuation.grossUnitCost,
            netUnitCost: valuation.netUnitCost,
          },
        });
      }

      // 2) Sumar el stock producido de la preparación (promedio ponderado del costo).
      const producedQty = preparation.yieldQuantity * batches;
      const prevStock = preparation.currentStock;
      const newPrepStock = prevStock + producedQty;
      // La tanda entra a su propio costo de producción; el resto del stock
      // conserva el suyo. Es el mismo promedio ponderado de las compras.
      const { totalPurchaseCost: newTotalValue, grossUnitCost, netUnitCost, netUsableQuantity } =
        valueIngredientAt(preparation, newPrepStock, {
          previousStock: prevStock,
          entryUnitCost: producedQty > 0 ? batchCost / producedQty : null,
        });

      await tx.stockMovement.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          ingredientId: preparation.id,
          type: 'PRODUCTION',
          quantity: producedQty,
          unitCost: producedQty > 0 ? batchCost / producedQty : undefined,
          previousStock: prevStock,
          newStock: newPrepStock,
          notes: `Producción de ${batches} tanda(s)`,
          createdBy: ctx.userId,
          createdByName: ctx.name,
        },
      });

      const updated = await tx.ingredient.update({
        where: { id: preparation.id },
        data: {
          currentStock: newPrepStock,
          grossStockQuantity: newPrepStock,
          totalPurchaseCost: newTotalValue,
          netUsableQuantity,
          grossUnitCost,
          netUnitCost,
        },
      });

      return {
        preparation: this.toIngredientDto(updated),
        producedQty,
        batchCost,
      };
    });
  }

  private async assertPreparation(ctx: TenantContext, id: string) {
    const ingredient = await this.assertIngredient(ctx, id);
    if (!ingredient.isPreparation) {
      throw new BadRequestException(`${ingredient.name} no es una preparación`);
    }
    return ingredient;
  }

  private toPreparationComponentDto(
    line: Prisma.PreparationComponentGetPayload<{ include: { component: true } }>,
  ) {
    const unitCost = convertUnitCost(
      line.component.netUnitCost,
      line.component.recipeUnit,
      line.unit,
      line.component,
    );
    return {
      id: line.id,
      preparationId: line.preparationId,
      componentId: line.componentId,
      quantity: line.quantity,
      unit: line.unit,
      component: this.toIngredientDto(line.component),
      unitCost,
      lineCost: line.quantity * unitCost,
    };
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

  private normalizeIngredientName(name: string) {
    const normalized = name.trim().replace(/\s+/g, ' ');
    if (!normalized) throw new BadRequestException('Ingredient name is required');
    return normalized;
  }

  private async assertIngredientNameAvailable(
    ctx: TenantContext,
    name: string,
    excludeId?: string,
  ) {
    const existing = await this.prisma.ingredient.findFirst({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        isActive: true,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true, name: true },
    });
    if (!existing) return;
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'INGREDIENT_NAME_EXISTS',
      message: `Ya existe un ingrediente llamado "${existing.name}" en esta sucursal.`,
      details: { ingredientId: existing.id },
    });
  }

  private async releaseInactiveIngredientName(ctx: TenantContext, name: string) {
    const inactiveMatches = await this.prisma.ingredient.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        isActive: false,
        name: { equals: name, mode: 'insensitive' },
      },
      select: { id: true, name: true },
    });

    for (const item of inactiveMatches) {
      await this.prisma.ingredient.update({
        where: { id: item.id },
        data: { name: `${item.name}__deleted__${item.id.slice(-8)}` },
      });
    }
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
    const unitCost = convertUnitCost(
      line.ingredient.netUnitCost,
      line.ingredient.recipeUnit,
      line.unit,
      line.ingredient,
    );
    const wastePercent = line.wastePercent ?? 0;
    const lineCost = recipeLineCost(line, line.ingredient);

    return {
      id: line.id,
      tenantId: line.tenantId,
      branchId: line.branchId,
      productId: line.productId,
      ingredientId: line.ingredientId,
      ingredientName: line.ingredient.name,
      quantity: line.quantity,
      unit: line.unit,
      wastePercent,
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

}
