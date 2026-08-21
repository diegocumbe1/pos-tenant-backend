import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    example: 'supabase-refresh-token',
    description:
      'refresh_token entregado en el login. Supabase lo rota en cada uso: el ' +
      'que vuelve en la respuesta reemplaza al anterior.',
  })
  @IsString()
  @MinLength(10)
  refreshToken!: string;
}
