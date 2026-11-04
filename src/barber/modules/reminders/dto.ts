import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ALL_RULE_TYPES,
  NOTIFICATION_CASES,
} from '../../../notifications/notification-rules';
import {
  MAX_REMINDER_MINUTES,
  MAX_REMINDERS,
} from './appointment-reminders.calc';

export class NotificationFiltersDto {
  @IsOptional()
  @IsArray()
  @IsIn(ALL_RULE_TYPES, { each: true })
  types?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  staffIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  staffRoleCodes?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  serviceIds?: string[];

  @IsOptional()
  @IsArray()
  @IsIn(NOTIFICATION_CASES, { each: true })
  cases?: string[];
}

export class PauseNotificationsDto {
  /** Hasta cuándo. */
  @IsDateString()
  until!: string;
}

export class UpsertReminderRuleDto {
  /** Minutos antes de la cita. Vacío = sin avisos. */
  @IsArray()
  @ArrayMaxSize(MAX_REMINDERS)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(MAX_REMINDER_MINUTES, { each: true })
  offsetsMinutes!: number[];

  @IsOptional()
  @IsIn(['ALL', 'MINE'])
  scope?: 'ALL' | 'MINE';

  /** Solo el dueño: la persona o el rol no lo pueden cambiar ni pausar. */
  @IsOptional()
  @IsBoolean()
  locked?: boolean;

  /** Todas, solo las que elija, o ninguna. Por defecto, todas. */
  @IsOptional()
  @IsIn(['ALL', 'CUSTOM', 'NONE'])
  mode?: 'ALL' | 'CUSTOM' | 'NONE';

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationFiltersDto)
  filters?: NotificationFiltersDto;
}
