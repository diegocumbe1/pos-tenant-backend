import { PartialType } from '@nestjs/mapped-types';
import { ExpenseFrequency } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateExpenseDto {
  /** Categoría de egreso (el vocabulario lo define el frontend). */
  @IsString()
  @MaxLength(40)
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

  /** Recurrencia (fijo/recurrente). Default ONE_TIME / no recurrente. */
  @IsOptional()
  @IsEnum(ExpenseFrequency)
  frequency?: ExpenseFrequency;

  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;

  /** Próxima fecha de causación (epoch ms) para recurrentes. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  dueDate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateExpenseDto extends PartialType(CreateExpenseDto) {}
