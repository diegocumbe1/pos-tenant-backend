import { PartialType } from '@nestjs/mapped-types';
import { IsIn, IsInt, IsOptional, IsPositive, Matches, Min } from 'class-validator';

export const GOAL_METRICS = ['revenue', 'profit'] as const;
export const GOAL_PERIOD_TYPES = ['MONTHLY', 'WEEKLY', 'BIWEEKLY'] as const;

export class CreateFinanceGoalDto {
  /** Formato YYYY-MM (ancla; para semanal/quincenal es el mes del inicio). */
  @Matches(/^\d{4}-\d{2}$/, { message: 'periodMonth must be YYYY-MM' })
  periodMonth!: string;

  @IsIn(GOAL_METRICS as unknown as string[])
  metric!: string;

  @IsInt()
  @Min(0)
  targetCOP!: number;

  @IsOptional()
  @IsIn(GOAL_PERIOD_TYPES as unknown as string[])
  periodType?: string;

  /** Inicio del período (epoch ms). Requerido para WEEKLY/BIWEEKLY. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  periodStart?: number;

  /** Fin del período (epoch ms, exclusivo). */
  @IsOptional()
  @IsInt()
  @IsPositive()
  periodEnd?: number;
}

export class UpdateFinanceGoalDto extends PartialType(CreateFinanceGoalDto) {}
