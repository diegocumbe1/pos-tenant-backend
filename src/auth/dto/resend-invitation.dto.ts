import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class ResendInvitationDto {
  @ApiProperty({
    example: 'usuario@correo.com',
    description: 'Correo del usuario invitado al que se le reenviará el acceso',
  })
  @IsEmail()
  email!: string;
}
