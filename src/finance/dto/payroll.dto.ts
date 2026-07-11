import { PartialType } from '@nestjs/mapped-types';
import { PayFrequency } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePayrollDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsString()
  @MaxLength(160)
  staffName!: string;

  @IsString()
  @MaxLength(80)
  role!: string;

  /** Formato YYYY-MM. */
  @Matches(/^\d{4}-\d{2}$/, { message: 'periodMonth must be YYYY-MM' })
  periodMonth!: string;

  /** Frecuencia de pago; default MONTHLY. */
  @IsOptional()
  @IsEnum(PayFrequency)
  payFrequency?: PayFrequency;

  /** Bruto POR PERÍODO de pago (base + bonos). */
  @IsInt()
  @Min(0)
  grossCOP!: number;

  /** Neto POR PERÍODO de pago. */
  @IsInt()
  @Min(0)
  netCOP!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  bonusesCOP?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  deductionsCOP?: number;

  /** Timestamp en ms; omitir/null = pendiente de pago. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  paidAt?: number | null;
}

export class UpdatePayrollDto extends PartialType(CreatePayrollDto) {}
