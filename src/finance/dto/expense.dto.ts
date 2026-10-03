import { PartialType } from '@nestjs/mapped-types';
import { ExpenseFrequency, ExpenseNature } from '@prisma/client';
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

  /**
   * Fijo / variable / ocasional. Omitirlo = la de su categoría. Se manda
   * explícito solo cuando el dueño la cambia.
   */
  @IsOptional()
  @IsEnum(ExpenseNature)
  nature?: ExpenseNature;

  /**
   * Descuento recibido sobre el valor normal. `amountCOP` es lo PAGADO (puede
   * ser 0 si el descuento fue del 100%); esto solo deja ver el ahorro.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  discountCOP?: number;
}

export class UpdateExpenseDto extends PartialType(CreateExpenseDto) {}
