import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// Bloque de reserva adicional (modo recursos). minutes = duración del bloque;
// priceCOP opcional (null/omitido = se deriva de la tarifa por hora base).
export class DurationOptionDto {
  @IsInt()
  @Min(5)
  minutes!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceCOP?: number | null;
}

export class CreateBarberServiceDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsInt()
  @Min(5)
  durationMin!: number;

  @IsInt()
  @Min(0)
  priceCOP!: number;

  // Costo de insumos del servicio. Sin él la vertical queda fuera del margen.
  @IsOptional()
  @IsInt()
  @Min(0)
  costCOP?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DurationOptionDto)
  @ArrayMaxSize(12)
  durationOptions?: DurationOptionDto[];

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  imageUrls?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  resultDuration?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  retouchPriceCOP?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  retouchNote?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  primaryImageUrl?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateBarberServiceDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  durationMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceCOP?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  costCOP?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DurationOptionDto)
  @ArrayMaxSize(12)
  durationOptions?: DurationOptionDto[];

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  imageUrls?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  resultDuration?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  retouchPriceCOP?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  retouchNote?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  primaryImageUrl?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
