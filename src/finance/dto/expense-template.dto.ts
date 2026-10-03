import { PartialType } from '@nestjs/mapped-types';
import { ExpenseFrequency, ExpenseNature } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/** Día calendario 'YYYY-MM-DD' (Colombia). */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Frecuencias que tiene sentido repetir: un gasto único no es plantilla. */
const RECURRING = ['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'ANNUAL'] as const;

export class CreateExpenseTemplateDto {
  @IsString()
  @MaxLength(40)
  category!: string;

  @IsString()
  @MaxLength(160)
  concept!: string;

  @IsInt()
  @Min(0)
  amountCOP!: number;

  @IsOptional()
  @IsEnum(ExpenseNature)
  nature?: ExpenseNature;

  @IsIn(RECURRING as unknown as string[])
  frequency!: ExpenseFrequency;

  /** Primera ocurrencia. Define el día en que se repite. */
  @Matches(DAY)
  anchorDay!: string;

  @IsOptional()
  @Matches(DAY)
  endsOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /** Solo 'PLATFORM_SUBSCRIPTION': la plantilla de Lynko sembrada con un botón. */
  @IsOptional()
  @IsIn(['PLATFORM_SUBSCRIPTION'])
  sourceType?: string;
}

export class UpdateExpenseTemplateDto extends PartialType(
  CreateExpenseTemplateDto,
) {
  /** Pausar sin borrar: deja de aparecer en "Por pagar". */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Pagar una ocurrencia: crea el gasto real, con su monto y su fecha. */
export class PayExpenseOccurrenceDto {
  /** Qué ocurrencia se paga ('YYYY-MM-DD'). */
  @Matches(DAY)
  occurrence!: string;

  /**
   * Lo PAGADO. Puede ser 0 (descuento del 100%). Por defecto: el valor de la
   * plantilla menos el descuento.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  amountCOP?: number;

  /** Descuento recibido ese periodo, sobre el valor normal. */
  @IsOptional()
  @IsInt()
  @Min(0)
  discountCOP?: number;

  /** Cuándo se pagó. Por defecto, hoy. */
  @IsOptional()
  @Matches(DAY)
  paidOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Omitir una ocurrencia ("ese mes no hubo"). */
export class SkipExpenseOccurrenceDto {
  @Matches(DAY)
  occurrence!: string;
}
