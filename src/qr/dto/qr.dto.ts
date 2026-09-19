import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Cambios sobre un QR ya creado.
 *
 * Fíjate en lo que NO está: `code`. El código es el recurso impreso y no se
 * edita nunca por acá; rotarlo es una operación aparte (`/revoke`) justamente
 * para que no ocurra por descuido al guardar otra cosa.
 */
export class UpdateQrCodeDto {
  @ApiPropertyOptional({
    example: '/sites/bella-chic',
    description:
      'Ruta interna (preferida) o URL absoluta http(s). El código impreso no cambia.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  targetUrl?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'false = el QR deja de redirigir y muestra el aviso de Lynko.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ example: 'Bella Chic' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  cardTitle?: string;

  @ApiPropertyOptional({ example: 'Belleza y cuidado personal' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  cardSubtitle?: string;

  @ApiPropertyOptional({ example: 'Escanea y conoce nuestro catálogo' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  cardCta?: string;
}

/** Destino inicial opcional al crear; si no viene, lo deduce el servicio. */
export class CreateQrCodeDto {
  @ApiPropertyOptional({ example: '/sites/bella-chic' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  targetUrl?: string;
}

export class RevokeQrCodeDto {
  @ApiProperty({
    example: 'Se filtró el arte impreso',
    description: 'Queda en la auditoría: revocar mata los QR ya repartidos.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason!: string;
}
