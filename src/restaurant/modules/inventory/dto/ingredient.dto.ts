import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
} from 'class-validator';

export const MEASURE_UNITS = [
  'g',
  'kg',
  'lb',
  'ml',
  'L',
  'unit',
  'package',
  'portion',
  'tbsp',
  'tsp',
] as const;

export class CreateIngredientDto {
  @IsString()
  categoryId!: string;

  @IsString()
  name!: string;

  @IsIn(MEASURE_UNITS as unknown as string[])
  purchaseUnit!: string;

  @IsIn(MEASURE_UNITS as unknown as string[])
  recipeUnit!: string;

  @IsOptional()
  @IsIn(MEASURE_UNITS as unknown as string[])
  unit?: string;

  // Cuántas unidades de receta trae 1 unidad de compra (ej: 1 paquete = 10 unidades).
  // Requerido cuando compra y receta no tienen conversión física (paquete→unidad).
  @IsOptional()
  @IsNumber()
  @Min(0)
  purchaseToRecipeFactor?: number;

  // Preparación: se produce a partir de otros ingredientes (ej: carne de birria).
  @IsOptional()
  @IsBoolean()
  isPreparation?: boolean;

  // Cuánto produce 1 tanda, en la unidad de compra (ej: 5 kg).
  @IsOptional()
  @IsNumber()
  @IsPositive()
  yieldQuantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  grossStockQuantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  currentStock?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(99.999)
  technicalWastePercentage?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  totalPurchaseCost?: number;

  @IsNumber()
  @Min(0)
  minStock!: number;

  @IsOptional()
  @IsString()
  supplierName?: string;

  @IsOptional()
  @IsDateString()
  expirationDate?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateIngredientDto {
  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(MEASURE_UNITS as unknown as string[])
  purchaseUnit?: string;

  @IsOptional()
  @IsIn(MEASURE_UNITS as unknown as string[])
  recipeUnit?: string;

  @IsOptional()
  @IsIn(MEASURE_UNITS as unknown as string[])
  unit?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  purchaseToRecipeFactor?: number;

  @IsOptional()
  @IsBoolean()
  isPreparation?: boolean;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  yieldQuantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(99.999)
  technicalWastePercentage?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  totalPurchaseCost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minStock?: number;

  @IsOptional()
  @IsString()
  supplierName?: string;

  @IsOptional()
  @IsDateString()
  expirationDate?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
