import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsOptional } from 'class-validator';

export class CleanupTenantByEmailDto {
  @ApiProperty({
    example: 'diegocumbre.04@gmail.com',
    description: 'Email de un usuario perteneciente al tenant a limpiar.',
  })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Debe ser true para ejecutar el borrado real.',
  })
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Si es true, fuerza modo preview aunque confirm sea true.',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
