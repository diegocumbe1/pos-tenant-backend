import { ContractType, PayFrequency } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/** Body de PUT /staff/compensation/role-templates/:role (upsert por rol). */
export class UpsertRoleTemplateDto {
  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  role?: string;

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
}
