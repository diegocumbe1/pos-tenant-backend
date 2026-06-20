import {
  IsDateString,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  MinLength,
} from 'class-validator';

export class PublicAvailabilityQueryDto {
  // Opcional: en modo recursos se consulta disponibilidad del servicio/espacio.
  @IsOptional()
  @IsString()
  specialistId?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date must be YYYY-MM-DD',
  })
  date!: string;

  @IsOptional()
  @IsString()
  serviceId?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  durationMinutes?: number;
}

export class PublicSpecialistsQueryDto {
  @IsOptional()
  @IsString()
  serviceId?: string;
}

export class CreatePublicAppointmentDto {
  @IsString()
  @MinLength(2)
  customerName!: string;

  @IsString()
  @MinLength(5)
  customerPhone!: string;

  @IsOptional()
  @IsEmail()
  customerEmail?: string;

  @IsString()
  serviceId!: string;

  // Opcional: en modo recursos (reserva de un espacio) no hay especialista.
  @IsOptional()
  @IsString()
  specialistId?: string;

  @IsDateString()
  scheduledAt!: string;

  // Modo recursos: duración del bloque elegido. Si se omite, se usa la base.
  @IsOptional()
  @IsInt()
  @Min(5)
  durationMinutes?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
