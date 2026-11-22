import { ContractType, PayFrequency } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Body de PUT /staff/compensation/:staffId (upsert).
 * Incluye claves de identidad que el front envía (tenantId/branchId/staffId):
 * se whitelistean para pasar `forbidNonWhitelisted`, pero el service usa el
 * TenantContext como fuente autoritativa de tenant/branch.
 */
export class UpsertCompensationDto {
  @IsOptional()
  @IsString()
  staffId?: string;

  @IsIn(['tenant_user', 'specialist'])
  source!: 'tenant_user' | 'specialist';

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsEnum(ContractType)
  contractType!: ContractType;

  @IsEnum(PayFrequency)
  payFrequency!: PayFrequency;

  @IsInt()
  @Min(0)
  baseAmount!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  defaultBonuses?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  hourlyRate?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  expectedHoursPerPeriod?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  commissionPercent?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  /** Días del mes en que se paga (1–31; 31 = último día). Vacío = los de siempre. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(31, { each: true })
  payDays?: number[];

  /** Desde cuándo corre el contrato (YYYY-MM-DD). */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'payStartDate must be YYYY-MM-DD' })
  payStartDate?: string | null;
}
