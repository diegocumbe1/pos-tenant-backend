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
  Matches,
  Max,
  MaxLength,
  Min,
  NotEquals,
  ValidateNested,
} from 'class-validator';
import { CALENDAR_DAY } from '../../../shared/retail-calendar-day';

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

  @ApiPropertyOptional({
    example: 'loc_xxx',
    description:
      'Bodega a la que entra, o de la que sale, la mercancía. Omitirlo NO es ' +
      'un error: una entrada sin bodega va a la principal, y una salida sale ' +
      'de donde haya, empezando por la principal.',
  })
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiPropertyOptional({
    example: '2026-12-12',
    description:
      'Fecha de vencimiento (día calendario) de lo que entra. Solo se usa en ' +
      'entradas de productos que vencen; sin ella entra "sin fecha".',
  })
  @IsOptional()
  @Matches(CALENDAR_DAY, {
    message: 'La fecha de vencimiento debe ser AAAA-MM-DD',
  })
  expiresOn?: string;

  @ApiPropertyOptional({
    example: 'L2409',
    description: 'Lote impreso en el empaque',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  lotCode?: string;
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
    example: 1,
    description:
      'Lo que el cliente creía que había cuando calculó `stock`. Si no ' +
      'coincide con lo que hay ahora, el reparto se rechaza (409) en vez de ' +
      'pisar un cambio hecho desde otro lado. Es lo que permite que la pantalla ' +
      'ofrezca "sumar lo que llegó" sin arriesgarse a sobrescribir.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedStock?: number;

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

  @ApiPropertyOptional({
    example: 'loc_xxx',
    description:
      'En qué bodega se está repartiendo. Por defecto la principal, que es ' +
      'donde figura lo que nadie había repartido.',
  })
  @IsOptional()
  @IsString()
  locationId?: string;
}

// ─── Vencimientos ────────────────────────────────────────────────────────────

/**
 * Ponerle fecha a unidades que ya están en la bodega "sin fecha".
 *
 * Es la manera de arrancar: el producto ya tenía 11 unidades cuando se le
 * encendió "vence", y nadie va a sacarlas y volverlas a entrar para fecharlas.
 * No mueve stock ni kardex: solo dice cuándo vencen unidades que ya estaban.
 */
export class CreateRetailStockLotDto {
  @ApiProperty({ example: 'prod_xxx' })
  @IsString()
  productId!: string;

  @ApiPropertyOptional({ example: 'var_xxx' })
  @IsOptional()
  @IsString()
  variantId?: string;

  @ApiPropertyOptional({ description: 'Sin bodega = la principal' })
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiPropertyOptional({
    example: '2026-12-12',
    description:
      'Obligatoria al fechar. Opcional al asignar opción (`assignVariantId`): ' +
      'la fecha nunca es obligatoria, y asignar solo el sabor es válido.',
  })
  @IsOptional()
  @Matches(CALENDAR_DAY, {
    message: 'La fecha de vencimiento debe ser AAAA-MM-DD',
  })
  expiresOn?: string;

  @ApiPropertyOptional({
    example: 'var_chocolate',
    description:
      'Solo con unidades SIN opción (variantId vacío) de un producto que reparte ' +
      'por opción: además de fecharlas, se le asignan a esta opción. Es el caso ' +
      'de una compra que entró sin decir de qué sabor era.',
  })
  @IsOptional()
  @IsString()
  assignVariantId?: string;

  @ApiProperty({
    example: 6,
    description: 'Cuántas de las "sin fecha" vencen ese día',
  })
  @IsInt()
  @Min(1)
  qty!: number;

  @ApiPropertyOptional({ example: 'L2409' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  lotCode?: string;
}

/** Corregir la fecha o el código de un lote mal digitado. */
export class UpdateRetailStockLotDto {
  @ApiPropertyOptional({ example: '2026-12-12' })
  @IsOptional()
  @Matches(CALENDAR_DAY, {
    message: 'La fecha de vencimiento debe ser AAAA-MM-DD',
  })
  expiresOn?: string;

  @ApiPropertyOptional({ example: 'L2409', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  lotCode?: string | null;
}

export class UpdateRetailSettingsDto {
  @ApiPropertyOptional({
    example: 60,
    description: 'Días de anticipación estándar para avisar que algo vence.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(730)
  expiryAlertDays?: number;
}

/** Pasar unidades de un lote SIN opción a una opción, conservando su fecha. */
export class AssignRetailStockLotDto {
  @ApiProperty({ example: 'var_chocolate' })
  @IsString()
  variantId!: string;

  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(1)
  qty!: number;
}
