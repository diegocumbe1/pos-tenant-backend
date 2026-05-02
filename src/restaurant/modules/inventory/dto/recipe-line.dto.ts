import { IsIn, IsNumber, IsString, Min } from 'class-validator';
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
}
