import { ContractType, PayFrequency } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
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
}
