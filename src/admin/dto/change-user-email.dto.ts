import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class ChangeUserEmailDto {
  @ApiProperty({
    example: 'old@uselynko.com',
    description: 'Email actual del usuario (case-insensitive).',
  })
  @IsEmail()
  oldEmail!: string;

  @ApiProperty({
    example: 'new@uselynko.com',
    description:
      'Email nuevo. Se aplica en Supabase Auth y en la fila local de users.',
  })
  @IsEmail()
  newEmail!: string;
}
