import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class SimulateAgentDto {
  @ApiProperty({
    example: '3001234567',
    description:
      'Celular del supuesto remitente. Se normaliza igual que en WhatsApp.',
  })
  @IsString()
  @MinLength(7)
  @MaxLength(20)
  phone!: string;

  @ApiProperty({ example: '¿cuánto vendí hoy?' })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message!: string;
}
