import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateBarberRecurringBookingDto {
  @IsString()
  customerId!: string;

  // La cancha o recurso.
  @IsString()
  serviceId!: string;

  @IsOptional()
  @IsString()
  staffId?: string;

  // Uno por día: "martes y jueves" crea dos reservas fijas. 0 = domingo.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays!: number[];

  @Matches(TIME_RE)
  startTime!: string;

  @IsInt()
  @Min(15)
  @Max(720)
  durationMin!: number;

  // Precio pactado por vez. Sin dato = el de la cancha para esa duración.
  @IsOptional()
  @IsInt()
  @Min(0)
  priceCOP?: number;

  // Sin dato = hoy.
  @IsOptional()
  @Matches(DAY_RE)
  activeFrom?: string;

  // Sin dato = hasta que se termine.
  @IsOptional()
  @Matches(DAY_RE)
  activeUntil?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class EndBarberRecurringBookingDto {
  // Primer día SIN la reserva fija. Las reservas desde ese día se cancelan.
  @Matches(DAY_RE)
  from!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  reason?: string;
}
