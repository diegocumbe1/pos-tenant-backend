import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RetailStockMovementType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  NotEquals,
  ValidateNested,
} from 'class-validator';

/** Tipos que puede registrar un humano. SALE lo genera solo el POS. */
export const MANUAL_MOVEMENT_TYPES = [
  'PURCHASE',
  'RETURN',
  'ADJUSTMENT',
  'LOSS',
] as const;

export class CreateRetailStockMovementDto {
  @ApiProperty({ example: 'prod_xxx' })
  @IsString()
  productId!: string;

  @ApiProperty({ enum: MANUAL_MOVEMENT_TYPES, example: 'PURCHASE' })
  @IsEnum(RetailStockMovementType)
  @NotEquals(RetailStockMovementType.SALE, {
    message: 'Las salidas por venta se registran desde el POS',
  })
  type!: RetailStockMovementType;

  @ApiProperty({
    example: 12,
    description: 'Firmado: positivo entra, negativo sale. Nunca 0.',
  })
  @IsInt()
  @NotEquals(0, { message: 'La cantidad no puede ser 0' })
  quantity!: number;

  @ApiPropertyOptional({
    example: 28000,
    description: 'Costo unitario de compra',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  unitCostCOP?: number;

  @ApiPropertyOptional({ example: 'Compra proveedor Mayoristas SAS' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @ApiPropertyOptional({ example: 'FAC-00921' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  reference?: string;

  @ApiPropertyOptional({
    example: 'var_xxx',
    description:
      'Valor al que entra o del que sale la mercancía, en productos que reparten ' +
      'existencias por opción. Mueve la fila del valor y el total del producto. ' +
      'Obligatorio para salidas de un producto que reparte.',
  })
  @IsOptional()
  @IsString()
  variantId?: string;
}

export class VariantDistributionItemDto {
  @ApiPropertyOptional({
    example: 'var_xxx',
    description:
      'Fila a la que se le fija el conteo. Alternativa a `optionValueId`.',
  })
  @IsOptional()
  @IsString()
  variantId?: string;

  @ApiPropertyOptional({
    example: 'v_arruru',
    description:
      'Valor de la opción, como alternativa a `variantId`. Existe para que el ' +
      'admin pueda repartir en el mismo guardado en que marca el grupo: en ese ' +
      'momento las filas todavía no existen, así que el cliente no puede conocer ' +
      'sus ids, pero sí conoce el id del valor porque lo acaba de escribir.',
  })
  @IsOptional()
  @IsString()
  optionValueId?: string;

  @ApiProperty({
    example: 4,
    description: 'Cuántas unidades son de este valor',
  })
  @IsInt()
  @Min(0)
  stock!: number;

  @ApiPropertyOptional({
    example: 2,
    description: 'Alerta de stock bajo propia',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  minStock?: number;
}

/**
 * Reparto del total entre los valores. Los que no vengan conservan su conteo,
 * así se puede corregir un solo aroma sin reenviar todos.
 */
export class SetVariantDistributionDto {
  @ApiProperty({ type: [VariantDistributionItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => VariantDistributionItemDto)
  items!: VariantDistributionItemDto[];
}
