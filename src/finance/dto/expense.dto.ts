import { PartialType } from '@nestjs/mapped-types';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export const EXPENSE_CATEGORIES = [
  'rent',
  'utilities',
  'supplies',
  'marketing',
  'other',
] as const;

export class CreateExpenseDto {
  @IsIn(EXPENSE_CATEGORIES as unknown as string[])
  category!: string;

  @IsString()
  @MaxLength(160)
  concept!: string;

  @IsInt()
  @Min(0)
  amountCOP!: number;

  /** Timestamp en ms. */
  @IsInt()
  @IsPositive()
  incurredAt!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateExpenseDto extends PartialType(CreateExpenseDto) {}
