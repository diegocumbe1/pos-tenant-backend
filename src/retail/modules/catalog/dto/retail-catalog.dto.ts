import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateRetailCategoryDto {
  @ApiProperty({ example: 'iPhone 17 Pro' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ example: '📱' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  emoji?: string;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'Visible en el sitio público' })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;
}

export class UpdateRetailCategoryDto extends PartialType(
  CreateRetailCategoryDto,
) {}

export class CreateRetailProductDto {
  @ApiProperty({ example: 'cat_xxx' })
  @IsString()
  categoryId!: string;

  @ApiProperty({ example: 'Funda transparente MagSafe' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'FND-17P-TRN-MGS' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  sku?: string;

  @ApiPropertyOptional({ example: '7701234567890' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  barcode?: string;

  @ApiPropertyOptional({ example: 'Spigen' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  brand?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: 28000, description: 'Costo de compra' })
  @IsOptional()
  @IsInt()
  @Min(0)
  costCOP?: number;

  @ApiProperty({ example: 65000, description: 'Precio de venta' })
  @IsInt()
  @Min(0)
  priceCOP!: number;

  @ApiPropertyOptional({
    example: 35,
    description: '% de ganancia sobre el precio con el que se sugirió priceCOP',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(99)
  saleMarginPct?: number;

  @ApiPropertyOptional({
    example: 32000,
    description: 'Piso de negociación. Solo lo edita el admin.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  minPriceCOP?: number;

  @ApiPropertyOptional({ example: 50, description: '% de ganancia mínima' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(99)
  minMarginPct?: number;

  @ApiPropertyOptional({ example: '🛡️' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  emoji?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  imageUrls?: string[];

  @ApiPropertyOptional({
    description: 'false para servicios que no descuentan stock',
  })
  @IsOptional()
  @IsBoolean()
  trackStock?: boolean;

  @ApiPropertyOptional({ example: 12, description: 'Stock inicial' })
  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number;

  @ApiPropertyOptional({ example: 3, description: 'Alerta de stock bajo' })
  @IsOptional()
  @IsInt()
  @Min(0)
  minStock?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Visible en el sitio público' })
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({
    example: { color: 'Transparente', compatible: 'iPhone 17 Pro' },
  })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;
}

export class UpdateRetailProductDto extends PartialType(
  CreateRetailProductDto,
) {}
