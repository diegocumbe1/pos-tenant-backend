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

/** Body de PATCH /staff/ledger/:id — corregir un movimiento ya registrado. */
export class UpdateLedgerEntryDto {
  @IsOptional()
  @IsEnum(LedgerEntryType)
  type?: LedgerEntryType;

  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/, { message: 'period must be YYYY-MM' })
  period?: string;

  // null = quitarlo (pasó a ser un incentivo o un descuento).
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  accountLabel?: string | null;

  // Día en que se hizo el pago (YYYY-MM-DD o ISO).
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string | null;
}

/** Query de GET /staff/compensation/earnings. */
export class EarningsQueryDto {
  @Matches(/^\d{4}-\d{2}$/, { message: 'period must be YYYY-MM' })
  period!: string;
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
