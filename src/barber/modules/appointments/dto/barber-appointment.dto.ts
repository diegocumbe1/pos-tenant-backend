import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

export class CreateBarberAppointmentDto {
  @IsString()
  customerId!: string;

  @IsString()
  serviceId!: string;

  // Opcional: en modo recursos no se asigna especialista.
  @IsOptional()
  @IsString()
  staffId?: string;

  @IsDateString()
  scheduledAt!: string;

  // Modo recursos: duración del bloque reservado. Si se omite, se usa la
  // duración base del servicio.
  @IsOptional()
  @IsInt()
  @Min(5)
  durationMinutes?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateBarberAppointmentDto {
  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  serviceId?: string;

  @IsOptional()
  @IsString()
  staffId?: string;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  durationMinutes?: number;

  @IsOptional()
  @IsString()
  status?: string;

  // Cuándo se prestó el servicio, si no fue el día agendado. Solo se usa al
  // completar la cita; después se corrige con el endpoint dedicado, que deja
  // rastro en el histórico. Acepta 'YYYY-MM-DD' o ISO completo.
  @IsOptional()
  @IsDateString()
  servedAt?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateBarberAppointmentServedAtDto {
  // El día en que realmente se prestó el servicio. 'YYYY-MM-DD' o ISO completo.
  @IsDateString()
  servedAt!: string;

  // Por qué se corrigió. Opcional, pero es lo que hace útil el histórico.
  @IsOptional()
  @IsString()
  @MinLength(2)
  reason?: string;
}

export class CancelBarberAppointmentDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  reason?: string;
}

export class RejectBarberAppointmentDto {
  // Motivo del rechazo: queda en el histórico para saber por qué se rechazó.
  @IsString()
  @MinLength(2)
  reason!: string;
}
