import { IsIn, IsNumber, IsPositive, IsString, Min } from 'class-validator';
import { MEASURE_UNITS } from './ingredient.dto';

// Línea de sub-receta de una preparación (ej: birria usa 500g de cebolla).
export class UpsertPreparationComponentDto {
  @IsString()
  componentId!: string;

  @IsNumber()
  @Min(0.000001)
  quantity!: number;

  @IsIn(MEASURE_UNITS as unknown as string[])
  unit!: string;
}

// Registrar producción de N tandas de una preparación.
export class ProducePreparationDto {
  @IsNumber()
  @IsPositive()
  batches!: number;
}
