import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RetailShipmentAttachmentKind } from '@prisma/client';
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

/**
 * Datos logísticos del paquete. Todos opcionales: un envío se puede abrir con
 * las ventas y nada más, y la guía y el costo se anotan cuando la
 * transportadora los dé, que casi nunca es en el mismo momento.
 */
export class RetailShipmentDetailsDto {
  @ApiPropertyOptional({ example: 'cus_xxx' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({
    example: 'Marcela Montero',
    description:
      'A nombre de quién va el paquete, si no es el cliente de las ventas.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  recipientName?: string;

  @ApiPropertyOptional({ example: '3001234567' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  recipientPhone?: string;

  @ApiPropertyOptional({ example: 'Cra 12 #34-56, Bucaramanga' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({ example: 'Servientrega' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  carrier?: string;

  @ApiPropertyOptional({ example: '1234567890', description: 'Número de guía' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  trackingCode?: string;

  @ApiPropertyOptional({ example: 18000, description: 'Lo que cuesta la guía' })
  @IsOptional()
  @IsInt()
  @Min(0)
  shippingCostCOP?: number;

  @ApiPropertyOptional({
    example: 18000,
    description:
      'Lo que se le cobra al cliente por el envío. Si se omite se copia del ' +
      'costo: lo normal es trasladar el flete tal cual. Mandar 0 explícitamente ' +
      'es un envío regalado.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  shippingChargedCOP?: number;

  @ApiPropertyOptional({ example: 'Va con el pedido de la semana pasada' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateRetailShipmentDto extends RetailShipmentDetailsDto {
  @ApiProperty({
    type: [String],
    example: ['sale_a', 'sale_b'],
    description:
      'Ventas que van en el paquete. Todas tienen que tener algo por entregar.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  saleIds!: string[];
}

export class UpdateRetailShipmentDto extends RetailShipmentDetailsDto {}

export class AddSalesToShipmentDto {
  @ApiProperty({ type: [String], example: ['sale_c'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  saleIds!: string[];
}

/**
 * Una línea que sale en este despacho.
 *
 * Es la misma forma que la entrega suelta de una venta —cantidad y, cuando el
 * producto reparte, cuál valor sale— porque es exactamente el mismo hecho: sale
 * mercancía de la estantería. Lo único que agrega el envío es que pasan varias
 * ventas a la vez y que queda anotado en qué paquete salió cada una.
 */
export class ShipRetailShipmentItemDto {
  @ApiProperty({ example: 'sale_xxx' })
  @IsString()
  saleId!: string;

  @ApiProperty({ example: 'item_xxx' })
  @IsString()
  saleItemId!: string;

  @ApiProperty({ example: 4 })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiPropertyOptional({
    example: 'var_xxx',
    description:
      'Valor que sale (aroma, talla…). Obligatorio en productos que reparten ' +
      'existencias por opción.',
  })
  @IsOptional()
  @IsString()
  variantId?: string;
}

export class ShipRetailShipmentDto {
  @ApiPropertyOptional({
    type: [ShipRetailShipmentItemDto],
    description:
      'Qué sale en el paquete. Si se omite, sale TODO lo que quede pendiente ' +
      'de las ventas del envío — que es el caso normal. Se manda explícito para ' +
      'despachar una parte, o para decir de qué aroma es cada unidad.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ShipRetailShipmentItemDto)
  items?: ShipRetailShipmentItemDto[];

  @ApiPropertyOptional({ example: 'Despachado por Servientrega' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/**
 * Un soporte ya subido.
 *
 * El archivo se sube por `POST /assets/upload` y acá solo se registra la URL que
 * ese endpoint devolvió: así el envío no tiene que saber nada de buckets y se
 * reusa el mismo camino que ya optimiza y valida imágenes en todo el producto.
 */
export class AddShipmentAttachmentDto {
  @ApiProperty({ enum: RetailShipmentAttachmentKind, example: 'IMAGE' })
  @IsEnum(RetailShipmentAttachmentKind)
  kind!: RetailShipmentAttachmentKind;

  @ApiProperty({ example: 'https://…/guia.webp' })
  @IsString()
  url!: string;

  @ApiPropertyOptional({
    example: 'tenant_x/shipment/guia.webp',
    description: 'Ruta en el bucket. Sin ella el archivo no se puede borrar.',
  })
  @IsOptional()
  @IsString()
  path?: string;

  @ApiPropertyOptional({ example: 'guia-servientrega.pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 245678 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sizeBytes?: number;

  @ApiPropertyOptional({ example: 'Guía de la transportadora' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;
}

/** Solo la descripción es editable: el archivo se reemplaza borrando y subiendo. */
export class UpdateShipmentAttachmentDto {
  @ApiPropertyOptional({ example: 'Comprobante del flete' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;
}

export class CancelRetailShipmentDto {
  @ApiPropertyOptional({ example: 'El cliente pidió recogerlo en tienda' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
