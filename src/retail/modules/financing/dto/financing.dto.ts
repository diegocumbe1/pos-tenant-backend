import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Términos de un convenio: comisión, plazo de giro y mínimo.
 *
 * NO HAY VALORES POR DEFECTO A PROPÓSITO. `feeBps` y `settlementDays` son
 * obligatorios porque salen del contrato de cada comercio y no hay dos iguales:
 * dos tiendas de la misma cuadra tienen comisiones distintas con el mismo
 * financiador. Un valor precargado se vuelve el valor que queda para siempre
 * —nadie corrige un campo que ya viene lleno— y produciría una utilidad falsa
 * que se ve verdadera.
 */
export class FinancingTermsDto {
  @ApiProperty({
    example: 650,
    description:
      'Comisión en PUNTOS BÁSICOS: 650 = 6,50%. Entero a propósito, un 6.5 ' +
      'flotante termina produciendo comisiones de $44.999,99999.',
  })
  @IsInt()
  @Min(0)
  @Max(10_000)
  feeBps!: number;

  @ApiProperty({
    example: 30,
    description: 'Días hasta el desembolso, según convenio.',
  })
  @IsInt()
  @Min(0)
  @Max(365)
  settlementDays!: number;

  @ApiPropertyOptional({ example: 0, description: '0 = sin mínimo.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  minAmountCOP?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  feeHasVat?: boolean;

  @ApiPropertyOptional({
    example: '2026-09-11',
    description:
      'Desde cuándo rigen estos términos (YYYY-MM-DD). Omitido = hoy. ' +
      'Retroactivo = se está corrigiendo un error de digitación, no ' +
      'renegociando; ver `recalculate`.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'effectiveFrom debe ser YYYY-MM-DD',
  })
  effectiveFrom?: string;

  @ApiPropertyOptional({
    example: 'renegociación',
    description: "Por qué cambió: 'renegociación' | 'corrección'.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @ApiPropertyOptional({
    example: false,
    description:
      'Solo para corregir un error de digitación: recalcula la comisión ' +
      'congelada y su gasto en las ventas desde `effectiveFrom`. El caso ' +
      'normal —renegociación— va en false y NO toca el pasado.',
  })
  @IsOptional()
  @IsBoolean()
  recalculate?: boolean;
}

export class CreateFinancingProviderDto extends FinancingTermsDto {
  @ApiProperty({ example: 'addi' })
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'code solo admite minúsculas, números y guiones',
  })
  code!: string;

  @ApiProperty({ example: 'Addi' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  label!: string;

  @ApiPropertyOptional({ example: 'Asesor: Juan · contrato 4421' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** Solo la identidad del convenio. Los números van por `PUT /terms`. */
export class UpdateFinancingProviderDto {
  @ApiPropertyOptional({ example: 'Addi' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  label?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** Registrar un giro que ya llegó al banco. */
export class CreateFinancingSettlementDto {
  @ApiProperty({ example: 'fin_xxx' })
  @IsString()
  providerId!: string;

  @ApiProperty({
    example: ['pay_xxx', 'pay_yyy'],
    description: 'Abonos de financiación que cubre este giro.',
    type: [String],
  })
  @IsString({ each: true })
  paymentIds!: string[];

  @ApiProperty({
    example: 4_280_000,
    description:
      'Lo que llegó DE VERDAD al banco. Si no coincide con lo esperado, la ' +
      'diferencia se registra como ajuste: no se esconde.',
  })
  @IsInt()
  @Min(0)
  receivedCOP!: number;

  @ApiPropertyOptional({ example: '2026-09-18' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'settledAt debe ser YYYY-MM-DD' })
  settledAt?: string;

  @ApiPropertyOptional({ example: 'Giro 88213' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/**
 * Resolver una venta que quedó esperando respuesta del financiador.
 *
 * Solo APPROVED o REJECTED: los demás estados no los pone una persona —SETTLED
 * lo pone el giro y REVERSED la anulación—, y ofrecerlos acá dejaría marcar una
 * venta como girada sin que haya entrado un peso.
 */
export class ResolveFinancingStatusDto {
  @ApiProperty({ example: 'APPROVED', enum: ['APPROVED', 'REJECTED'] })
  @IsIn(['APPROVED', 'REJECTED'])
  status!: 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({ example: 'Cupo insuficiente' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
