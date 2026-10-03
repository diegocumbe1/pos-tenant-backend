import { PartialType } from '@nestjs/mapped-types';
import {
  CapitalMovementKind,
  FundingSource,
  InterestPeriod,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Para qué gasto fue (todo o una parte) un aporte. */
export class CapitalAllocationDto {
  @IsString()
  @MaxLength(40)
  expenseId!: string;

  @IsInt()
  @Min(1)
  amountCOP!: number;
}

/** En qué se usó la plata que salió del negocio. */
export const WITHDRAWAL_PURPOSES = [
  'PERSONAL',
  'OTHER_BUSINESS',
  'PERSONAL_DEBT',
  'EMERGENCY',
  'OTHER',
] as const;

export class CreateCapitalMovementDto {
  @IsEnum(CapitalMovementKind)
  kind!: CapitalMovementKind;

  @IsInt()
  @Min(1)
  amountCOP!: number;

  /** Día calendario Colombia 'YYYY-MM-DD'. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  occurredOn!: string;

  /** Aporte en mercancía: capital que no pasa por la caja. */
  @IsOptional()
  @IsBoolean()
  inKind?: boolean;

  /** De dónde sacó el dueño la plata. Opcional. */
  @IsOptional()
  @IsEnum(FundingSource)
  fundingSource?: FundingSource;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  fundingNote?: string;

  /** Tasa en porcentaje (1,8 = 1,8%). Se guarda en puntos básicos. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  interestRatePct?: number;

  @IsOptional()
  @IsEnum(InterestPeriod)
  interestPeriod?: InterestPeriod;

  /** 'SUGGESTION_CONFIRMED' cuando sale de una sugerencia de Lynko. */
  @IsOptional()
  // REPLENISHMENT: devolver al negocio lo que se sacó de más. No es inversión.
  @IsIn(['MANUAL', 'SUGGESTION_CONFIRMED', 'REPLENISHMENT'])
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /** Solo retiros: en qué se usó la plata. */
  @IsOptional()
  @IsIn(WITHDRAWAL_PURPOSES as unknown as string[])
  purpose?: string;

  /**
   * Solo aportes y préstamos: a qué gasto(s) corresponde. Al editar,
   * REEMPLAZA los vínculos anteriores (mandar [] los quita).
   */
  /** Solo abonos (LOAN_REPAYMENT): a qué préstamo corresponde. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  repaysMovementId?: string;

  /** Solo abonos: true = salió de la caja del negocio; false = de tu bolsillo. */
  @IsOptional()
  @IsBoolean()
  paidFromBusiness?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CapitalAllocationDto)
  allocations?: CapitalAllocationDto[];
}

export class UpdateCapitalMovementDto extends PartialType(
  CreateCapitalMovementDto,
) {}

/** Cuánto de un gasto salió de las ventas (reinversión). 0 lo quita. */
export class SetExpenseFundingDto {
  @IsInt()
  @Min(0)
  fromSalesCOP!: number;
}
