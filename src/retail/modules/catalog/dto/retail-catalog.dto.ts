import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
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

/** Un valor elegible dentro de un grupo de opciones ("Negro", "M", "38"). */
export class RetailProductOptionValueDto {
  @ApiPropertyOptional({ description: 'Estable entre ediciones' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  id?: string;

  @ApiProperty({ example: 'Negro' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  label!: string;

  @ApiPropertyOptional({
    example: 'Negro mate · algodón peinado',
    description: 'Copy que el admin muestra junto al valor en el sitio',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  copy?: string;

  @ApiPropertyOptional({
    example: '#111827',
    description: 'Solo grupos de color',
  })
  @IsOptional()
  @IsHexColor()
  hex?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Subconjunto de imageUrls del producto que muestra este valor',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  imageUrls?: string[];

  @ApiPropertyOptional({
    description: 'false = agotado, se muestra deshabilitado',
  })
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}

/** Grupo de opciones del producto: "Color", "Talla", o uno libre del admin. */
export class RetailProductOptionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  id?: string;

  @ApiProperty({ enum: ['color', 'size', 'custom'], example: 'color' })
  @IsIn(['color', 'size', 'custom'])
  kind!: 'color' | 'size' | 'custom';

  @ApiProperty({ example: 'Color' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label!: string;

  @ApiPropertyOptional({
    description: 'El cliente debe elegir para poder pedir',
  })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiProperty({ type: [RetailProductOptionValueDto] })
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => RetailProductOptionValueDto)
  values!: RetailProductOptionValueDto[];
}

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

  // Precios por volumen. Opcionales y anulables: `null` apaga el escalón (se
  // cobra el precio normal) y `undefined` lo deja como está. El margen y el
  // descuento NO se reciben: se derivan del costo y del precio de venta.
  @ApiPropertyOptional({
    example: 22000,
    nullable: true,
    description: 'Precio por unidad desde 6 unidades. null = escalón apagado.',
  })
  // `@IsOptional` ignora los validadores cuando el valor es null o undefined,
  // así que null pasa y llega tal cual al servicio para apagar el escalón.
  @IsOptional()
  @IsInt()
  @Min(0)
  wholesalePrice6COP?: number | null;

  @ApiPropertyOptional({
    example: 21500,
    nullable: true,
    description: 'Precio por unidad desde 12 unidades. null = escalón apagado.',
  })
  // `@IsOptional` ignora los validadores cuando el valor es null o undefined,
  // así que null pasa y llega tal cual al servicio para apagar el escalón.
  @IsOptional()
  @IsInt()
  @Min(0)
  wholesalePrice12COP?: number | null;

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
    example: { compatible: 'iPhone 17 Pro' },
  })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: [RetailProductOptionDto],
    description:
      'Color, talla, etc. Lista vacía = el producto no ofrece opciones y el ' +
      'catálogo no muestra ningún selector.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => RetailProductOptionDto)
  options?: RetailProductOptionDto[];

  @ApiPropertyOptional({
    example: 'opt_aromas',
    nullable: true,
    description:
      'Id del grupo de `options` que lleva el conteo de existencias (p. ej. Aromas). ' +
      'null = el stock es del producto entero. Al señalarlo se crea una fila de ' +
      'inventario por cada valor del grupo, arrancando en 0: el stock actual queda ' +
      'como pendiente de repartir hasta que se cuente cuántas hay de cada uno.',
  })
  @IsOptional()
  @IsString()
  stockOptionId?: string | null;
}

export class UpdateRetailProductDto extends PartialType(
  CreateRetailProductDto,
) {}
