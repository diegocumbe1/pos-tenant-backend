import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CatalogStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Slug de la URL pública. Minúsculas, números y guiones.
 *
 * Se valida con regex y no solo se "normaliza" porque el slug se comparte
 * impreso en un QR: si cambia después de repartido, el link muere.
 */
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** WhatsApp en formato internacional, sin + ni espacios: 573001234567. */
const WHATSAPP_REGEX = /^[0-9]{8,15}$/;

/**
 * Los campos OPCIONALES en cualquier caso.
 *
 * `businessName` y `whatsapp` NO están acá aunque se puedan editar: son
 * obligatorios al crear, y declararlos como opcionales en la base para volverlos
 * requeridos en `Create` choca con TypeScript (TS2612). Cada DTO los declara
 * con la obligatoriedad que le toca.
 */
export class CatalogDetailsDto {
  @ApiPropertyOptional({ example: 'Septiembre, mes del amor y la amistad' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  season?: string;

  @ApiPropertyOptional({ example: 'Florencia, Caquetá' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional({ example: 'Para este mes del amor y la amistad…' })
  @IsOptional()
  @IsString()
  @MaxLength(600)
  intro?: string;

  @ApiPropertyOptional({ example: '#d81159' })
  @IsOptional()
  @IsString()
  @MaxLength(9)
  themePrimary?: string;

  @ApiPropertyOptional({ example: '#ffb6c9' })
  @IsOptional()
  @IsString()
  @MaxLength(9)
  themeAccent?: string;

  @ApiPropertyOptional({ example: 'light', enum: ['light', 'dark', 'auto'] })
  @IsOptional()
  @IsEnum(['light', 'dark', 'auto'])
  themeMode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  seoTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  seoDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ogImageUrl?: string;

  @ApiPropertyOptional({ description: 'A quién se le factura este catálogo.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contactName?: string;

  @ApiPropertyOptional({ example: 'Pagó temporada 2026, renueva en diciembre' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  contactNote?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description:
      'Referencia comercial de cuándo renueva. NO apaga el catálogo por sí sola.',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

export class CreateCatalogDto extends CatalogDetailsDto {
  @ApiProperty({ example: 'Detalles con Amor' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  businessName!: string;

  @ApiProperty({ example: '573001234567' })
  @Matches(WHATSAPP_REGEX, {
    message:
      'El WhatsApp va en formato internacional, solo números: 573001234567',
  })
  whatsapp!: string;

  @ApiPropertyOptional({
    example: 'detalles-con-amor',
    description:
      'Si se omite se deriva del nombre del negocio. Se puede cambiar mientras ' +
      'el catálogo sea borrador; después el link ya está repartido.',
  })
  @IsOptional()
  @Matches(SLUG_REGEX, {
    message: 'El slug va en minúsculas, sin tildes ni espacios: mi-catalogo',
  })
  @MaxLength(60)
  slug?: string;
}

export class UpdateCatalogDto extends CatalogDetailsDto {
  @ApiPropertyOptional({ example: 'Detalles con Amor' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  businessName?: string;

  @ApiPropertyOptional({ example: '573001234567' })
  @IsOptional()
  @Matches(WHATSAPP_REGEX, {
    message:
      'El WhatsApp va en formato internacional, solo números: 573001234567',
  })
  whatsapp?: string;

  @ApiPropertyOptional({ example: 'detalles-con-amor' })
  @IsOptional()
  @Matches(SLUG_REGEX, {
    message: 'El slug va en minúsculas, sin tildes ni espacios: mi-catalogo',
  })
  @MaxLength(60)
  slug?: string;
}

export class ListCatalogsQueryDto {
  @ApiPropertyOptional({ enum: CatalogStatus })
  @IsOptional()
  @IsEnum(CatalogStatus)
  status?: CatalogStatus;

  @ApiPropertyOptional({ description: 'Busca por nombre del negocio o slug.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;
}

/** Igual que arriba: `name` y `priceCOP` los declara cada DTO concreto. */
export class CatalogProductDetailsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  @ApiPropertyOptional({ example: 'Tazas' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @ApiPropertyOptional({
    example: 17000,
    description: 'Precio por unidad desde 6. null quita el escalón.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  wholesalePrice6COP?: number | null;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}

export class CreateCatalogProductDto extends CatalogProductDetailsDto {
  @ApiProperty({ example: 'Mug corazones' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 20000 })
  @IsInt()
  @Min(0)
  priceCOP!: number;
}

export class UpdateCatalogProductDto extends CatalogProductDetailsDto {
  @ApiPropertyOptional({ example: 'Mug corazones' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 20000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceCOP?: number;
}

/** Reordenar en lote: mandar todo el orden nuevo de una, no ítem por ítem. */
export class ReorderCatalogProductsDto {
  @ApiProperty({
    type: [String],
    description: 'Ids de los productos en el orden en que deben quedar.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  productIds!: string[];
}

export class ReorderCatalogImagesDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  imageIds!: string[];
}

/** Carga inicial: pegar un catálogo entero en vez de crear producto por producto. */
export class BulkCatalogProductsDto {
  @ApiProperty({ type: [CreateCatalogProductDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateCatalogProductDto)
  products!: CreateCatalogProductDto[];
}
