import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
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
