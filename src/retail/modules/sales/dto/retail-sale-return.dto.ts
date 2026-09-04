import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RetailPaymentMethod, RetailReturnSettlement } from '@prisma/client';
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
  ValidateNested,
} from 'class-validator';

/** Una línea que VUELVE a la tienda. */
export class ReturnedItemDto {
  @ApiProperty({
    example: 'item_xxx',
    description: 'Línea de la venta original',
  })
  @IsString()
  saleItemId!: string;

  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiPropertyOptional({
    example: 'var_xxx',
    description:
      'A qué valor vuelve, en productos que reparten existencias por opción. ' +
      'Puede ser distinto del que salió: se llevó Sandía y devuelve Sandía, ' +
      'pero el reingreso tiene que decir a cuál fila de inventario entra.',
  })
  @IsOptional()
  @IsString()
  variantId?: string;
}

/** Una línea que SE LLEVA el cliente a cambio. */
export class ReplacementItemDto {
  @ApiProperty({ example: 'prod_xxx' })
  @IsString()
  productId!: string;

  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiPropertyOptional({
    example: 'var_xxx',
    description: 'Obligatorio si el producto reparte existencias por opción.',
  })
  @IsOptional()
  @IsString()
  variantId?: string;

  @ApiPropertyOptional({
    example: 22000,
    description:
      'Precio con el que se valora lo que se lleva. Si se omite, el precio ' +
      'actual del producto.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  unitPriceCOP?: number;
}

export class CreateRetailSaleReturnDto {
  @ApiProperty({ type: [ReturnedItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnedItemDto)
  returnedItems!: ReturnedItemDto[];

  @ApiPropertyOptional({
    type: [ReplacementItemDto],
    description:
      'Lo que se lleva a cambio. Vacío = devolución pura. Con contenido, la ' +
      'operación es un cambio y la diferencia de valor se salda.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReplacementItemDto)
  replacementItems?: ReplacementItemDto[];

  @ApiPropertyOptional({
    enum: RetailReturnSettlement,
    description:
      'En qué queda la diferencia. Si se omite se deduce: sin diferencia NONE, ' +
      'a favor del cliente REFUNDED, en contra CHARGED. Se manda explícito para ' +
      'decir "queda debiendo" o "no se le devuelve".',
  })
  @IsOptional()
  @IsEnum(RetailReturnSettlement)
  settlement?: RetailReturnSettlement;

  @ApiPropertyOptional({
    enum: RetailPaymentMethod,
    description: 'Con qué se movió la plata, cuando se movió.',
  })
  @IsOptional()
  @IsEnum(RetailPaymentMethod)
  paymentMethod?: RetailPaymentMethod;

  @ApiPropertyOptional({ example: 'No le gustó el aroma' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;

  @ApiPropertyOptional({ example: 'Vino la mamá a cambiarlo' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
