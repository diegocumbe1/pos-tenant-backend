import { Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
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

/** Acudiente del inscrito (menor de edad o quien responde por él). */
export class PublicSignupGuardianDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(7)
  @MaxLength(30)
  phone!: string;

  // "Mamá", "Papá", "Tío"… libre.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  relationship?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}

/** Sí/No con el detalle cuando es sí ("¿cuál?", "¿dónde?"). */
export class PublicIntakeYesNoDto {
  @IsBoolean()
  has!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  detail?: string;
}

export class PublicIntakeHealthDto {
  @ValidateNested()
  @Type(() => PublicIntakeYesNoDto)
  disease!: PublicIntakeYesNoDto;

  // Lesión en los últimos 6 meses.
  @ValidateNested()
  @Type(() => PublicIntakeYesNoDto)
  injury!: PublicIntakeYesNoDto;

  // Molestias físicas hoy.
  @ValidateNested()
  @Type(() => PublicIntakeYesNoDto)
  discomfort!: PublicIntakeYesNoDto;

  // Restricción médica para hacer ejercicio ("Ninguna" vale).
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  restrictions!: string;
}

/**
 * Lo que acepta al inscribirse. Los tres primeros son obligatorios: sin ellos
 * no se registra. Fotos y videos es opcional (sí o no).
 */
export class PublicIntakeConsentsDto {
  @Equals(true, { message: 'Debes confirmar que la información es verídica' })
  truthful!: boolean;

  @Equals(true, { message: 'Debes autorizar el tratamiento de datos personales' })
  dataPolicy!: boolean;

  @Equals(true, { message: 'Debes declarar que haces actividad física bajo tu responsabilidad' })
  selfResponsibility!: boolean;

  @IsBoolean()
  media!: boolean;
}

/**
 * Ficha deportiva completa (formulario "Ficha deportiva" del sitio): perfil,
 * salud, objetivo, disponibilidad y consentimientos. Se guarda tal cual en
 * `BarberCustomer.intake`.
 */
export class PublicSignupIntakeDto {
  @IsOptional()
  @IsIn(['CC', 'TI', 'RC', 'CE', 'PA'])
  documentType?: string;

  @IsOptional()
  @IsIn(['F', 'M', 'O'])
  sex?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  sport?: string;

  @IsOptional()
  @IsIn(['NONE', 'RECREATIONAL', 'FORMATIVE', 'COMPETITIVE'])
  sportLevel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  club?: string;

  @ValidateNested()
  @Type(() => PublicIntakeHealthDto)
  health!: PublicIntakeHealthDto;

  @IsString()
  @MinLength(2)
  @MaxLength(1000)
  goal!: string;

  // { mon: ['06:00', '07:00'], ... }: la hora en que empieza cada bloque.
  // Se limpia en el servicio (días y horas válidos).
  @IsOptional()
  @IsObject()
  availability?: Record<string, string[]>;

  // "Valoración física", "Rehabilitación"… lo que le interesa además del plan.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  interest?: string;

  @ValidateNested()
  @Type(() => PublicIntakeConsentsDto)
  consents!: PublicIntakeConsentsDto;
}

/**
 * Inscripción desde el sitio público (gimnasio sin agenda): deja al cliente
 * registrado y le devuelve cómo pagar. No crea cita ni cobro.
 */
export class CreatePublicSignupDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(7)
  @MaxLength(30)
  phone!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  document?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'birthDate must be YYYY-MM-DD' })
  birthDate?: string;

  // El plan o servicio que le interesa (opcional).
  @IsOptional()
  @IsString()
  serviceId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PublicSignupGuardianDto)
  guardian?: PublicSignupGuardianDto;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  // Solo con el formulario "Ficha deportiva".
  @IsOptional()
  @ValidateNested()
  @Type(() => PublicSignupIntakeDto)
  intake?: PublicSignupIntakeDto;
}
