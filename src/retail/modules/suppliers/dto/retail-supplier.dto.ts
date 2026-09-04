import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { RetailSupplierLedgerKind } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateRetailSupplierDto {
  @ApiProperty({ example: 'Crea con Arte' })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ example: 'Marcela' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  contactName?: string;

  @ApiPropertyOptional({ example: '3001234567' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional({ example: 'ventas@creaconarte.co' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;

  @ApiPropertyOptional({ example: 'Bucaramanga' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional({ example: 'Despacha los martes' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateRetailSupplierDto extends PartialType(
  CreateRetailSupplierDto,
) {}

/**
 * Un movimiento metido a mano en la cuenta del proveedor.
 *
 * Solo para lo que el sistema no puede deducir: una nota crédito que mandaron
 * por fuera, o el saldo que se traía de antes de empezar a llevar la cuenta.
 * Los movimientos que sí se deducen —el pedido confirmado, el giro, el faltante
 * al cerrar— los escribe el propio flujo de compras y no se registran acá.
 */
export class CreateSupplierLedgerEntryDto {
  @ApiProperty({ enum: RetailSupplierLedgerKind, example: 'CREDIT_NOTE' })
  @IsEnum(RetailSupplierLedgerKind)
  kind!: RetailSupplierLedgerKind;

  @ApiProperty({
    example: -80000,
    description:
      'Signo desde el lado de la tienda: positivo = le debo al proveedor, ' +
      'negativo = el proveedor me debe.',
  })
  @IsInt()
  amountCOP!: number;

  @ApiPropertyOptional({ example: 'Nota crédito NC-4421' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @ApiPropertyOptional({ description: 'Cuándo ocurrió; por defecto, ahora.' })
  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  @ApiPropertyOptional({ description: 'Pedido al que corresponde, si aplica.' })
  @IsOptional()
  @IsString()
  purchaseItemId?: string;
}
