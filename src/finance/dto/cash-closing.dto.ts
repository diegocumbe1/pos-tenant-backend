import { MoneyAccountType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Los medios de cobro que pueden caer en una cuenta por defecto. */
export const ACCOUNT_METHODS = [
  'CASH',
  'TRANSFER',
  'CARD',
  'FINANCING',
  'OTHER',
] as const;

export class CreateMoneyAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @IsEnum(MoneyAccountType)
  type!: MoneyAccountType;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ACCOUNT_METHODS as unknown as string[], { each: true })
  defaultForMethods?: string[];
}

export class UpdateMoneyAccountDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsEnum(MoneyAccountType)
  type?: MoneyAccountType;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ACCOUNT_METHODS as unknown as string[], { each: true })
  defaultForMethods?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ClosingLineDto {
  @IsString()
  @MaxLength(40)
  accountId!: string;

  /** Lo que hay de verdad. Un sobregiro se escribe en negativo. */
  @IsInt()
  countedCOP!: number;
}

export class ClosingPreviewDto {
  /** Día calendario Colombia. Por defecto, hoy. */
  @IsOptional()
  @Matches(DAY)
  day?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ClosingLineDto)
  lines!: ClosingLineDto[];
}

export class CreateClosingDto extends ClosingPreviewDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /** Ya había un cierre ese día y se quiere corregir. */
  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}

export class CreateTransferDto {
  @IsString()
  @MaxLength(40)
  fromAccountId!: string;

  @IsString()
  @MaxLength(40)
  toAccountId!: string;

  @IsInt()
  @Min(1)
  amountCOP!: number;

  @Matches(DAY)
  occurredOn!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** Decir de qué cuenta salió un movimiento que se quedó sin cuenta. */
export class AssignAccountDto {
  @IsIn(['EXPENSE', 'CAPITAL'])
  origin!: 'EXPENSE' | 'CAPITAL';

  @IsString()
  @MaxLength(40)
  refId!: string;

  @IsString()
  @MaxLength(40)
  moneyAccountId!: string;
}
