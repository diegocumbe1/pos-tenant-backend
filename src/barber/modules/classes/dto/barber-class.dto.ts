import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateBarberClassScheduleDto {
  @IsString()
  serviceId!: string;

  @IsOptional()
  @IsString()
  staffId?: string;

  // Uno por día: "lunes, miércoles y viernes" crea tres horarios. 0 = domingo.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays!: number[];

  // Hora Colombia 'HH:mm'.
  @Matches(TIME_RE)
  startTime!: string;

  // Sin dato = la duración del servicio.
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(600)
  durationMin?: number;

  // Sin dato = el cupo del servicio.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  capacity?: number;

  // Sin dato = hoy.
  @IsOptional()
  @Matches(DAY_RE)
  activeFrom?: string;

  @IsOptional()
  @Matches(DAY_RE)
  activeUntil?: string;
}

export class UpdateBarberClassScheduleDto {
  @IsOptional()
  @IsString()
  staffId?: string | null;

  @IsOptional()
  @Matches(TIME_RE)
  startTime?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(600)
  durationMin?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  capacity?: number;

  // Desde qué día aplica el cambio. Sin dato = hoy. Nunca antes de hoy.
  @IsOptional()
  @Matches(DAY_RE)
  effectiveFrom?: string;
}

export class ListBarberClassSchedulesQueryDto {
  // "true" = también los archivados y las versiones que ya terminaron.
  @IsOptional()
  @IsIn(['true', 'false'])
  history?: 'true' | 'false';
}

export class ListBarberClassSessionsQueryDto {
  @Matches(DAY_RE)
  from!: string;

  @Matches(DAY_RE)
  to!: string;
}

/**
 * Una clase se identifica por su sesión guardada o, si todavía no tiene a nadie,
 * por su horario + hora de inicio (la sesión "virtual" que sale del horario).
 */
export class BarberClassSessionRefDto {
  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsString()
  scheduleId?: string;

  // Instante ISO de inicio de la clase.
  @IsOptional()
  @IsString()
  startsAt?: string;
}

export class AddBarberClassAttendeeDto extends BarberClassSessionRefDto {
  @IsString()
  customerId!: string;

  // Ya llegó: se inscribe y se marca la asistencia de una vez.
  @IsOptional()
  @IsBoolean()
  attended?: boolean;
}

export class MarkBarberClassAttendanceDto extends BarberClassSessionRefDto {
  // Los que vinieron. Los inscritos que no estén aquí quedan como ausentes.
  @IsArray()
  @IsString({ each: true })
  presentCustomerIds!: string[];
}

/** Solo esta clase: cupo, entrenador o cancelarla. */
export class UpdateBarberClassSessionDto extends BarberClassSessionRefDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  capacity?: number;

  @IsOptional()
  @IsString()
  staffId?: string | null;

  @IsOptional()
  @IsIn(['SCHEDULED', 'CANCELLED'])
  status?: 'SCHEDULED' | 'CANCELLED';

  @IsOptional()
  @IsString()
  reason?: string;
}

export class SetBarberClassAttendeeDto {
  @IsBoolean()
  attended!: boolean;
}

export class CreateBarberClassEnrollmentDto {
  @IsString()
  customerId!: string;

  @IsOptional()
  @Matches(DAY_RE)
  activeFrom?: string;
}
