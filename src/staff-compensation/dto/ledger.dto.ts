import { LedgerEntryType, PaymentMethod } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/** Body de POST /staff/ledger. */
export class CreateLedgerEntryDto {
  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsString()
  staffId!: string;

  @IsString()
  @MaxLength(160)
  staffName!: string;

  @IsEnum(LedgerEntryType)
  type!: LedgerEntryType;

  @IsInt()
  @Min(1)
  amount!: number;

  /** Período de nómina YYYY-MM. */
  @Matches(/^\d{4}-\d{2}$/, { message: 'period must be YYYY-MM' })
  period!: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  accountLabel?: string;

  @IsOptional()
  @IsDateString()
  coversFrom?: string;

  @IsOptional()
  @IsDateString()
  coversTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** Query de GET /staff/ledger. */
export class LedgerQueryDto {
  @IsOptional()
  @IsString()
  staffId?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/, { message: 'period must be YYYY-MM' })
  period?: string;
}
