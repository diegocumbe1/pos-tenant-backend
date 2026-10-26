import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  SUPPORT_MAX_MINUTES,
  SUPPORT_MIN_MINUTES,
} from './support-session.service';

export class StartSupportSessionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  tenantId!: string;

  @ApiProperty({ example: 'Corregir precios mal cargados — ticket #123' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ example: 60, default: 60 })
  @IsOptional()
  @IsInt()
  @Min(SUPPORT_MIN_MINUTES)
  @Max(SUPPORT_MAX_MINUTES)
  durationMinutes?: number;
}

export class ListSupportSessionsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cursor?: string;
}
