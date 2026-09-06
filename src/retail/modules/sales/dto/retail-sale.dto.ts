import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  RetailDeliveryStatus,
  RetailPaymentMethod,
  RetailPaymentStatus,
  RetailSaleType,
} from '@prisma/client';
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
  ValidateIf,
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

  @ApiPropertyOptional({
    example: 'var_xxx',
    description:
      'Valor que se vende (aroma, sabor…) en productos que reparten existencias ' +
      'por opción. Obligatorio en esos productos: sin él no se sabe de cuál fila ' +
      'de inventario descontar.',
  })
  @IsOptional()
  @IsString()
  variantId?: string;
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

  @ApiPropertyOptional({
    enum: RetailDeliveryStatus,
    example: 'DELIVERED',
    description:
      'Omitido = DELIVERED (el cliente se la llevó). PENDING deja la venta en la ' +
      'bandeja de entregas. No cambia el cobro ni el stock: la mercancía ya está ' +
      'apartada para ese cliente.',
  })
  @IsOptional()
  @IsEnum(RetailDeliveryStatus)
  deliveryStatus?: RetailDeliveryStatus;

  @ApiPropertyOptional({
    enum: RetailPaymentStatus,
    example: 'PAID',
    description:
      'Omitido = PAID. PENDING deja la venta fiada: el stock SÍ sale, pero el ' +
      'ingreso no se cuenta hasta marcarla pagada. Es independiente de la entrega.',
  })
  @IsOptional()
  @IsEnum(RetailPaymentStatus)
  paymentStatus?: RetailPaymentStatus;

  @ApiPropertyOptional({
    example: 'Pasa el viernes · Cra 12 #3-45',
    description: 'Dónde, cuándo o a quién se entrega.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  deliveryNote?: string;

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

  @ApiPropertyOptional({
    example: '2026-09-03',
    description:
      'Día en que se vendió de verdad, si no es hoy. Se registra la venta de ' +
      'ayer cuando no hubo tiempo de meterla en el momento, y la fecha manda ' +
      'sobre finanzas: el ingreso pesa en el día que se escriba. Acepta ' +
      "'YYYY-MM-DD' —se le pone la hora actual— o un instante ISO completo. " +
      'No se acepta una fecha futura. Omitido = ahora.',
  })
  @IsOptional()
  @IsString()
  soldAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/**
 * Corrige el día de una venta ya registrada.
 *
 * EL CASO. Se vendió ayer y se metió al sistema hoy, o se digitó con la fecha
 * equivocada. Sin esto, la única salida era anular y volver a digitar, que
 * además mueve el inventario dos veces.
 */
export class UpdateRetailSaleDateDto {
  @ApiProperty({
    example: '2026-09-03',
    description:
      "Día correcto de la venta: 'YYYY-MM-DD' o un instante ISO. No puede ser " +
      'futuro.',
  })
  @IsString()
  soldAt!: string;

  @ApiPropertyOptional({
    example: 'Se vendió ayer, se digitó hoy',
    description:
      'Por qué se corrige. Queda en la nota de la venta: mover un ingreso de ' +
      'día sin decir por qué es lo que después nadie sabe explicar.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

/**
 * Registra un abono: plata que entró por una venta.
 *
 * EL CASO. El cliente manda 50.000 de un pedido de 300.000 y el resto después.
 * Antes eso no se podía anotar —la venta estaba cobrada o no— y lo que se hacía
 * era bajarle el precio a mano, dejando el histórico diciendo que se vendió más
 * barato en vez de que el cliente ya había abonado.
 */
export class CreateRetailSalePaymentDto {
  @ApiProperty({
    example: 50000,
    description:
      'Cuánto entró. Siempre positivo y no más que el saldo: un reverso se hace ' +
      'anulando el abono, no registrando uno negativo.',
  })
  @IsInt()
  @Min(1)
  amountCOP!: number;

  @ApiPropertyOptional({
    enum: RetailPaymentMethod,
    example: 'TRANSFER',
    description:
      'Con qué pagó ESTE abono. Puede ser distinto en cada uno: el primero en ' +
      'efectivo y el segundo por transferencia. Omitido = el de la venta.',
  })
  @IsOptional()
  @IsEnum(RetailPaymentMethod)
  paymentMethod?: RetailPaymentMethod;

  @ApiPropertyOptional({
    example: '2026-09-03',
    description:
      'Cuándo entró la plata, si no fue hoy. Mismo formato que la fecha de la ' +
      "venta: 'YYYY-MM-DD' o un instante ISO. No puede ser futura.",
  })
  @IsOptional()
  @IsString()
  paidAt?: string;

  @ApiPropertyOptional({
    example: 'Mandó por Nequi, quedó debiendo 2.000',
    description:
      'Siempre disponible y siempre opcional. Queda en el abono y en el ' +
      'histórico de la venta.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @ApiPropertyOptional({ description: 'Caja abierta en la que se recibió' })
  @IsOptional()
  @IsString()
  cashSessionId?: string;
}

/**
 * Anula un abono mal digitado.
 *
 * No lo borra ni lo edita: la plata entró un día y eso no se reescribe. El abono
 * anulado deja de contar para el saldo pero sigue en el histórico, junto con el
 * motivo por el que se anuló.
 */
export class VoidRetailSalePaymentDto {
  @ApiPropertyOptional({ example: 'Se digitó 500.000 en vez de 50.000' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

/** Una anotación a mano en el histórico de la venta, sin más consecuencia. */
export class CreateRetailSaleNoteDto {
  @ApiProperty({ example: 'El cliente pasa el viernes por el resto' })
  @IsString()
  @MaxLength(300)
  note!: string;
}

/**
 * Cambia (o pone) el cliente de una venta ya registrada.
 *
 * EL CASO. Se cobró de afán sin asociar a nadie, o se eligió el cliente
 * equivocado de la lista. Sin esto la única salida era anular y volver a
 * digitar, que mueve el inventario dos veces y le cambia el consecutivo.
 *
 * NO ES INOCENTE: reescribe el histórico de compras de dos clientes. Por eso va
 * con el permiso de corrección y queda en el histórico de la venta.
 */
export class UpdateRetailSaleCustomerDto {
  @ApiPropertyOptional({
    example: 'cus_xxx',
    description:
      'Cliente al que queda asociada la venta. `null` la deja sin cliente, que ' +
      'es lo correcto cuando se asoció a la persona equivocada y no se sabe ' +
      'quién era: inventar un dueño es peor que no tenerlo.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  customerId?: string | null;

  @ApiPropertyOptional({ example: 'Se cobró sin asociar al cliente' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class DeliverRetailSaleItemDto {
  @ApiProperty({ example: 'item_xxx', description: 'Línea de la venta' })
  @IsString()
  saleItemId!: string;

  @ApiProperty({
    example: 1,
    description:
      'Cuántas unidades de esa línea se entregan ahora. Puede ser menos que lo ' +
      'comprado: el resto queda pendiente.',
  })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiPropertyOptional({
    example: 'var_xxx',
    description:
      'Aroma que se entrega, en productos que reparten existencias. Se define ' +
      'AQUÍ y no al cobrar: el cliente compró unidades, no aromas concretos.',
  })
  @IsOptional()
  @IsString()
  variantId?: string;
}

/**
 * Registra una entrega (total o parcial) de una venta pendiente.
 *
 * Es lo que mueve el inventario: al cobrar una venta pendiente no sale nada.
 */
export class DeliverRetailSaleDto {
  @ApiProperty({ type: [DeliverRetailSaleItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DeliverRetailSaleItemDto)
  items!: DeliverRetailSaleItemDto[];

  @ApiPropertyOptional({
    example: 'Entregado a la mamá',
    description: 'Se agrega a la nota de entrega existente, no la reemplaza.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** Marca cobrada una venta que estaba fiada. */
export class PayRetailSaleDto {
  @ApiPropertyOptional({
    enum: RetailPaymentMethod,
    example: 'CASH',
    description:
      'Con qué se pagó al final, si difiere de lo anotado al vender.',
  })
  @IsOptional()
  @IsEnum(RetailPaymentMethod)
  paymentMethod?: RetailPaymentMethod;

  @ApiPropertyOptional({ example: 'Pagó en efectivo el viernes' })
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
