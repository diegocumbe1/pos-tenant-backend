import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsPositive } from 'class-validator';

export const PERIODS = ['today', 'week', 'month', 'custom'] as const;
export type Period = (typeof PERIODS)[number];

export class PeriodQueryDto {
  @ApiPropertyOptional({ enum: PERIODS, default: 'today' })
  @IsOptional()
  @IsIn(PERIODS as unknown as string[])
  period?: Period;

  @ApiPropertyOptional({ description: 'Timestamp ms (required if period=custom)' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  dateFrom?: number;

  @ApiPropertyOptional({ description: 'Timestamp ms (required if period=custom)' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  dateTo?: number;
}
