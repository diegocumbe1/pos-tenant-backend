import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsISO8601,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  GATEWAY_ENVIRONMENTS,
  GATEWAY_METHODS,
  GatewayEnvironment,
  GatewayMethod,
} from '../platform-gateway.constants';
import { FEE_METHODS, FeeMethod } from '../fee-calculator';

export class UpsertFeeRateDto {
  @ApiProperty({ enum: FEE_METHODS })
  @IsIn(FEE_METHODS as unknown as string[])
  method!: FeeMethod;

  @ApiProperty({ example: 265, description: 'Comisión en puntos básicos' })
  @IsInt()
  @Min(0)
  @Max(10_000)
  percentBps!: number;

  @ApiProperty({ example: 700 })
  @IsInt()
  @Min(0)
  fixedCOP!: number;

  @ApiProperty({ example: 1900, description: 'IVA sobre la comisión' })
  @IsInt()
  @Min(0)
  @Max(10_000)
  taxBps!: number;

  @ApiProperty({ example: 150, description: 'Retefuente. Solo tarjeta.' })
  @IsInt()
  @Min(0)
  @Max(10_000)
  retefuenteBps!: number;

  @ApiProperty({ example: 20, description: 'ReteICA. Cambia por municipio.' })
  @IsInt()
  @Min(0)
  @Max(10_000)
  reteIcaBps!: number;

  @ApiProperty({
    example: 1500,
    description: 'ReteIVA, sobre el IVA de la venta',
  })
  @IsInt()
  @Min(0)
  @Max(10_000)
  reteIvaBps!: number;

  @ApiProperty({ example: 1, description: 'Días hábiles hasta el abono' })
  @IsInt()
  @Min(0)
  @Max(30)
  settlementDays!: number;

  @ApiPropertyOptional({
    description: 'Desde cuándo rige. Vacío = ahora. No reescribe el pasado.',
  })
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class SimulateFeeDto {
  @ApiProperty({ example: 92000 })
  @IsInt()
  @Min(0)
  amount!: number;

  @ApiPropertyOptional({
    example: 1900,
    description: 'IVA de la VENTA, no de la comisión. 0 si es excluida.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  saleIvaBps?: number;
}

export class CreateChargeDto {
  @ApiProperty({
    example: 129000,
    description: 'Lo que se le va a cobrar, en COP',
  })
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiPropertyOptional({
    example: 129000,
    description: 'Precio de lista. La diferencia con `amount` es el descuento.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  listAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  discountReason?: string;

  @ApiPropertyOptional({ enum: [1, 3, 6, 12], default: 1 })
  @IsOptional()
  @IsIn([1, 3, 6, 12])
  termMonths?: number;

  @ApiProperty({ example: '2026-10-01' })
  @IsISO8601()
  periodStart!: string;

  @ApiProperty({ example: '2026-10-31' })
  @IsISO8601()
  periodEnd!: string;

  @ApiPropertyOptional({
    description: 'Cuándo caduca el link. Entra en la firma de integridad.',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({ description: 'Precarga el correo en el checkout' })
  @IsOptional()
  @IsEmail()
  customerEmail?: string;
}

export class UpdateGatewaySettingsDto {
  @ApiPropertyOptional({ description: 'Cobrar con pasarela activado' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ enum: GATEWAY_ENVIRONMENTS })
  @IsOptional()
  @IsIn(GATEWAY_ENVIRONMENTS as unknown as string[])
  environment?: GatewayEnvironment;

  @ApiPropertyOptional({ example: 'pub_test_xxx' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  publicKey?: string;

  // Los tres secretos siguen la misma convención que la API key de Resend:
  // vacío = "no la toques". Para borrarla está el `clear*` correspondiente.
  @ApiPropertyOptional({
    description: 'Vacío = conserva la guardada. Nunca se devuelve por la API.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  privateKey?: string;

  @ApiPropertyOptional({ description: 'Vacío = conserva el guardado.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  eventsSecret?: string;

  @ApiPropertyOptional({ description: 'Vacío = conserva el guardado.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  integritySecret?: string;

  @ApiPropertyOptional({ enum: GATEWAY_METHODS, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn(GATEWAY_METHODS as unknown as string[], { each: true })
  enabledMethods?: GatewayMethod[];

  @ApiPropertyOptional({ example: 'https://app.uselynko.com/pago/resultado' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  redirectUrl?: string;

  @ApiPropertyOptional({ description: 'true borra la llave privada guardada' })
  @IsOptional()
  @IsBoolean()
  clearPrivateKey?: boolean;

  @ApiPropertyOptional({ description: 'true borra el secreto de eventos' })
  @IsOptional()
  @IsBoolean()
  clearEventsSecret?: boolean;

  @ApiPropertyOptional({ description: 'true borra el secreto de integridad' })
  @IsOptional()
  @IsBoolean()
  clearIntegritySecret?: boolean;
}
