import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class InviteUserDto {
  @ApiProperty({
    example: 'usuario@correo.com',
    description: 'Correo del usuario que recibirá la invitación',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({
    example: 'Diego Cumbe',
    description: 'Nombre visible del usuario invitado',
  })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({
    example: 'tenant-001',
    description: 'Tenant al que pertenecerá el usuario invitado',
  })
  @IsString()
  @MinLength(3)
  tenantId!: string;

  @ApiProperty({
    example: 'OWNER',
    description: 'Rol inicial del usuario invitado dentro del tenant',
    enum: ['OWNER', 'MANAGER', 'WAITER', 'KITCHEN', 'CASHIER'],
  })
  @IsString()
  @IsIn(['OWNER', 'MANAGER', 'WAITER', 'KITCHEN', 'CASHIER'])
  roleCode!: string;
}

export class AcceptInviteDto {
  @ApiProperty({
    example: '12345678',
    description: 'Contraseña que el usuario definirá al aceptar la invitación',
  })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password!: string;

  @ApiProperty({
    example: 'supabase-refresh-token',
    description: 'refresh_token recibido en el hash del correo de invitacion',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  refreshToken?: string;
}

export class SignupInviteDto {
  @ApiProperty({ example: 'usuario@correo.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({
    example: 'Diego Cumbe',
    description: 'Nombre de la persona que sera OWNER del tenant',
  })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({
    example: 'OriWok',
    required: false,
    description:
      'Nombre comercial del negocio. Si se omite, se deriva del nombre.',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  businessName?: string;

  @ApiProperty({
    example: 'Sucursal Principal',
    required: false,
    description: 'Nombre de la primera sucursal',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  branchName?: string;

  @ApiProperty({
    example: 'restaurant',
    enum: ['restaurant', 'restaurante', 'barber', 'barberia', 'barbershop'],
  })
  @IsString()
  @IsIn(['restaurant', 'restaurante', 'barber', 'barberia', 'barbershop'])
  vertical!: string;

  @ApiProperty({
    example: 'BASIC',
    required: false,
    enum: ['BASIC', 'PRO', 'PREMIUM'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['BASIC', 'PRO', 'PREMIUM'])
  plan?: string;
}
