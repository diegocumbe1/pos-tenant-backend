import { IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export const STOCK_MOVEMENT_TYPES = [
  'PURCHASE',
  'CONSUMPTION',
  'ADJUSTMENT',
  'WASTE',
  'DAMAGE',
  'EXPIRED',
  'RETURN',
] as const;

export class CreateStockMovementDto {
  @IsString()
  ingredientId!: string;

  @IsIn(STOCK_MOVEMENT_TYPES as unknown as string[])
  type!: string;

  @IsNumber()
  quantity!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unitCost?: number;

  @IsOptional()
  @IsString()
  orderId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
