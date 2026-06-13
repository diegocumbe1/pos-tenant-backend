import { PartialType } from '@nestjs/mapped-types';
import {
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

  @IsInt()
  @Min(0)
  grossCOP!: number;

  @IsInt()
  @Min(0)
  netCOP!: number;

  /** Timestamp en ms; omitir/null = pendiente de pago. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  paidAt?: number | null;
}

export class UpdatePayrollDto extends PartialType(CreatePayrollDto) {}
