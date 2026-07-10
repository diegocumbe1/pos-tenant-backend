import { IsOptional, IsString, MinLength } from 'class-validator';

export class NotifyAppointmentBodyDto {
  @IsString()
  @MinLength(1)
  customerName!: string;

  @IsString()
  @MinLength(1)
  customerPhone!: string;

  @IsString()
  @MinLength(1)
  serviceName!: string;

  // Opcional: en reservas de recurso/espacio no hay especialista asignado.
  @IsOptional()
  @IsString()
  specialistName?: string;

  @IsString()
  @MinLength(1)
  startTime!: string;

  @IsString()
  @MinLength(1)
  businessName!: string;

  @IsOptional()
  @IsString()
  businessPhone?: string;
}

export class SendTestMessageDto {
  @IsString()
  @MinLength(1)
  to!: string;

  @IsString()
  @MinLength(1)
  body!: string;
}
