import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RetailPaymentMethod, RetailSaleType } from '@prisma/client';
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

export class CreateRetailSaleItemDto {
  @ApiProperty({ example: 'prod_xxx' })
  @IsString()
  productId!: string;

  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiPropertyOptional({
    example: 65000,
    description:
      'Precio unitario cobrado. Si se omite, se toma el precio actual del producto.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  unitPriceCOP?: number;

  @ApiPropertyOptional({ example: 0, description: 'Descuento de la línea' })
  @IsOptional()
  @IsInt()
  @Min(0)
  discountCOP?: number;
}

export class CreateRetailSaleDto {
  @ApiProperty({ type: [CreateRetailSaleItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateRetailSaleItemDto)
  items!: CreateRetailSaleItemDto[];

  @ApiPropertyOptional({ example: 'cus_xxx' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ enum: RetailPaymentMethod, example: 'CASH' })
  @IsOptional()
  @IsEnum(RetailPaymentMethod)
  paymentMethod?: RetailPaymentMethod;

  @ApiPropertyOptional({
    enum: RetailSaleType,
    example: 'RETAIL',
    description:
      'Lista de precios con la que se cobró. El precio unitario de cada línea llega en `items[].unitPriceCOP`; esto solo clasifica la venta para finanzas.',
  })
  @IsOptional()
  @IsEnum(RetailSaleType)
  saleType?: RetailSaleType;

  @ApiPropertyOptional({ example: 0, description: 'Descuento sobre el total' })
  @IsOptional()
  @IsInt()
  @Min(0)
  discountCOP?: number;

  @ApiPropertyOptional({ example: 100000, description: 'Efectivo recibido' })
  @IsOptional()
  @IsInt()
  @Min(0)
  receivedCOP?: number;

  @ApiPropertyOptional({ description: 'Caja abierta en la que se cobró' })
  @IsOptional()
  @IsString()
  cashSessionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class VoidRetailSaleDto {
  @ApiPropertyOptional({ example: 'Cliente devolvió el producto' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
