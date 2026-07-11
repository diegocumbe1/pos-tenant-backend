import { IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { MEASURE_UNITS } from './ingredient.dto';

export class UpsertRecipeLineDto {
  @IsString()
  productId!: string;

  @IsString()
  ingredientId!: string;

  @IsNumber()
  @Min(0.000001)
  quantity!: number;

  @IsIn(MEASURE_UNITS as unknown as string[])
  unit!: string;

  // Merma por línea (0–100). Pérdida al preparar, aparte de la merma técnica del ingrediente.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  wastePercent?: number;
}
