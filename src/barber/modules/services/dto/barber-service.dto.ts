import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

export class CreateBarberServiceDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  @Min(5)
  durationMin!: number;

  @IsInt()
  @Min(0)
  priceCOP!: number;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsString({ each: true })
  imageUrls?: string[];

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateBarberServiceDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
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
  @IsString()
  color?: string;

  @IsOptional()
  @IsString({ each: true })
  imageUrls?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
