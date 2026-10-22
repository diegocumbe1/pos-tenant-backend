import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateRetailCustomerDto {
  @ApiProperty({ example: 'Laura Restrepo' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: '3001234567' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: 'CC 1020304050' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  documentId?: string;

  @ApiPropertyOptional({ example: 'Calle 10 # 5-23' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  address?: string;

  @ApiPropertyOptional({ example: 'Garzón, Huila' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  // Cumpleaños. Día y mes van juntos o no van; el año es opcional aparte. La
  // regla cruzada (que el 31 de abril no exista) la valida el servicio, porque
  // aquí cada campo se mira solo. `null` en un PATCH lo borra.
  @ApiPropertyOptional({ example: 3, nullable: true, description: '1–12' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  birthMonth?: number | null;

  @ApiPropertyOptional({ example: 15, nullable: true, description: '1–31' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  birthDay?: number | null;

  @ApiPropertyOptional({ example: 1990, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2100)
  birthYear?: number | null;
}

/** Ventanas del filtro de cumpleaños, siempre en hora Colombia. */
export const BIRTHDAY_WINDOWS = ['today', 'week', 'month'] as const;
export type BirthdayWindow = (typeof BIRTHDAY_WINDOWS)[number];

export class ListRetailCustomersQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    enum: BIRTHDAY_WINDOWS,
    description:
      'Solo clientes que cumplen años hoy, en los próximos 7 días o este mes.',
  })
  @IsOptional()
  @IsIn(BIRTHDAY_WINDOWS)
  birthdays?: BirthdayWindow;

  @ApiPropertyOptional({
    example: 12,
    description:
      'Solo clientes que cumplen años en ese mes (1–12). Si llega junto con ' +
      '`birthdays`, manda este: es la elección más concreta.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  birthMonth?: number;
}

/**
 * Actualiza la ficha del cliente.
 *
 * LOS OPCIONALES ACEPTAN CADENA VACÍA PARA BORRARSE. En un PATCH, omitir un
 * campo significa "déjalo como estaba", así que sin esto no habría forma de
 * quitar un teléfono mal digitado: mandarlo vacío lo dejaba igual y el dueño
 * quedaba obligado a borrar al cliente y crearlo de nuevo, perdiendo su
 * historial de compras. El correo lleva su propia excepción porque `@IsEmail`
 * rechaza la cadena vacía.
 */
export class UpdateRetailCustomerDto extends PartialType(
  CreateRetailCustomerDto,
) {
  @ApiPropertyOptional({
    description: 'Cadena vacía para quitar el correo guardado.',
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== '')
  @IsEmail()
  declare email?: string;
}
