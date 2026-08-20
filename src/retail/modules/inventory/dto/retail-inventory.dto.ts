import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RetailStockMovementType } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  NotEquals,
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
}
