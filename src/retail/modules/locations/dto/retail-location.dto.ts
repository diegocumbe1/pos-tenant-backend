import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RetailLocationKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  Max,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class RetailLocationCountItemDto {
  @ApiProperty({ example: 'prod_xxx' })
  @IsString()
  productId!: string;

  @ApiPropertyOptional({ example: 'var_xxx' })
  @IsOptional()
  @IsString()
  variantId?: string;

  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(0)
  quantity!: number;
}

/** Una escala: si el total vendido SUPERA `aboveCOP`, el aliado se queda `pct`% de todo. */
export class AllyTierDto {
  @ApiProperty({ example: 50000 })
  @IsInt()
  @Min(0)
  aboveCOP!: number;

  @ApiProperty({ example: 12 })
  @IsNumber()
  @Min(0)
  @Max(100)
  pct!: number;
}

export class CreateRetailLocationDto {
  @ApiProperty({ example: 'Salón Nia' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({
    example: 'Nia Restrepo',
    description:
      'A quién buscar en ese sitio. Omitirlo NO es un error: la pantalla ' +
      'muestra el nombre de la bodega cuando no hay responsable, porque en la ' +
      'principal el responsable es el dueño y escribirlo sería ruido.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  holderName?: string;

  @ApiPropertyOptional({ example: '3001234567' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional({
    example: 'Deja el 10% cuando vende',
    description: 'Texto libre. Aquí va la comisión el día que exista una.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  note?: string;

  @ApiPropertyOptional({
    type: [Object],
    description:
      'Conteo inicial opcional: qué hay ya en ese sitio. Es un TRASLADO desde ' +
      'la principal, no una compra ni un ajuste — esas unidades ya estaban ' +
      'contadas, solo figuraban en la principal porque no había dónde más ' +
      'ponerlas. El total del inventario no se mueve, se reparte.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RetailLocationCountItemDto)
  initialCount?: RetailLocationCountItemDto[];

  @ApiPropertyOptional({ enum: RetailLocationKind, default: 'EXHIBITION' })
  @IsOptional()
  @IsEnum(RetailLocationKind)
  kind?: RetailLocationKind;

  @ApiPropertyOptional({ example: 15, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  countEveryDays?: number | null;

  @ApiPropertyOptional({
    type: () => [AllyTierDto],
    nullable: true,
    description:
      'Escalas propias del aliado. Omitir o null = las de la tienda.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AllyTierDto)
  allyTiers?: AllyTierDto[] | null;
}

export class UpdateRetailLocationDto {
  @ApiPropertyOptional({ example: 'Salón Nia' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ example: 'Nia Restrepo' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  holderName?: string;

  @ApiPropertyOptional({ example: '3001234567' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional({ example: 'Deja el 10% cuando vende' })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  note?: string;

  @ApiPropertyOptional({
    example: false,
    description:
      'Se desactiva, no se borra: su kardex tiene que sobrevivir. La principal ' +
      'no se puede desactivar.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    enum: RetailLocationKind,
    description:
      'EXHIBITION: exhibe (lo que falta en una revista vuelve a la principal). ' +
      'ALLY: el tercero vende (lo que falta se liquida con su escala).',
  })
  @IsOptional()
  @IsEnum(RetailLocationKind)
  kind?: RetailLocationKind;

  @ApiPropertyOptional({
    example: 15,
    nullable: true,
    description: 'Cada cuántos días se pasa revista. null = sin frecuencia.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  countEveryDays?: number | null;

  @ApiPropertyOptional({
    type: [AllyTierDto],
    nullable: true,
    description: 'Escalas propias de este aliado. null = las de la tienda.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AllyTierDto)
  allyTiers?: AllyTierDto[] | null;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class TransferLineDto {
  @ApiProperty({ example: 'prod_xxx' })
  @IsString()
  productId!: string;

  @ApiPropertyOptional({
    example: 'var_xxx',
    description: 'Aroma que se lleva, en productos que reparten por opción.',
  })
  @IsOptional()
  @IsString()
  variantId?: string;

  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(1)
  quantity!: number;
}

/**
 * Llevar mercancía de una bodega a otra.
 *
 * NO ES UNA VENTA NI UN PRÉSTAMO: no mueve plata, ni el stock total, ni
 * finanzas, ni el costo. Salen 3 de un lado y entran 3 al otro; la tienda sigue
 * teniendo las mismas 3.
 */
export class CreateRetailTransferDto {
  @ApiProperty({ example: 'loc_xxx' })
  @IsString()
  fromLocationId!: string;

  @ApiProperty({ example: 'loc_yyy' })
  @IsString()
  toLocationId!: string;

  @ApiProperty({ type: [TransferLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransferLineDto)
  items!: TransferLineDto[];

  @ApiPropertyOptional({ example: 'Reposición de fin de mes' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

/**
 * Conteo físico en un sitio: cuántas hay AHÍ, no cuántas entraron.
 *
 * Es idempotente —manda el saldo que debe quedar, no un delta— y se resuelve
 * como un traslado contra la principal, para que el total del inventario nunca
 * cambie por contar. Para que entre o salga mercancía de la tienda está el
 * movimiento de inventario, que sí toca el total.
 */
export class SetLocationCountDto {
  @ApiProperty({ type: [RetailLocationCountItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RetailLocationCountItemDto)
  items!: RetailLocationCountItemDto[];
}
