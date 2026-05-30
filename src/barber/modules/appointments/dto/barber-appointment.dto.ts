import { IsDateString, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateBarberAppointmentDto {
  @IsString()
  customerId!: string;

  @IsString()
  serviceId!: string;

  @IsString()
  staffId!: string;

  @IsDateString()
  scheduledAt!: string;

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
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CancelBarberAppointmentDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  reason?: string;
}
