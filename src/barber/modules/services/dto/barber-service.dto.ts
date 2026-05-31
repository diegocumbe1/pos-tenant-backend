import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

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
