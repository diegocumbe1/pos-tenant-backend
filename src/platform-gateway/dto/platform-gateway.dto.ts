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
  MaxLength,
  Min,
} from 'class-validator';
import {
  GATEWAY_ENVIRONMENTS,
  GATEWAY_METHODS,
  GatewayEnvironment,
  GatewayMethod,
} from '../platform-gateway.constants';

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
