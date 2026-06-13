import { PartialType } from '@nestjs/mapped-types';
import { IsIn, IsInt, Matches, Min } from 'class-validator';

export const GOAL_METRICS = ['revenue', 'profit'] as const;

export class CreateFinanceGoalDto {
  /** Formato YYYY-MM. */
  @Matches(/^\d{4}-\d{2}$/, { message: 'periodMonth must be YYYY-MM' })
  periodMonth!: string;

  @IsIn(GOAL_METRICS as unknown as string[])
  metric!: string;

  @IsInt()
  @Min(0)
  targetCOP!: number;
}

export class UpdateFinanceGoalDto extends PartialType(CreateFinanceGoalDto) {}
