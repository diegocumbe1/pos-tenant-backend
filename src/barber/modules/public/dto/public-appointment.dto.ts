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
  @IsString()
  specialistId!: string;

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

  @IsString()
  specialistId!: string;

  @IsDateString()
  scheduledAt!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
