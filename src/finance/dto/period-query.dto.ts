import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsPositive, Max } from 'class-validator';

export const PERIODS = ['today', 'week', 'month', 'custom'] as const;
export type Period = (typeof PERIODS)[number];

export class PeriodQueryDto {
  @ApiPropertyOptional({ enum: PERIODS, default: 'today' })
  @IsOptional()
  @IsIn(PERIODS as unknown as string[])
  period?: Period;

  @ApiPropertyOptional({
    description: 'Timestamp ms (required if period=custom)',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  dateFrom?: number;

  @ApiPropertyOptional({
    description: 'Timestamp ms (required if period=custom)',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  dateTo?: number;

  /**
   * Cuántos productos devuelve `topProductsByRevenue`.
   *
   * El dashboard pide los 10 de siempre; el listado completo pide el tope. El
   * ranking se calcula igual en los dos casos —solo cambia el corte—, así que
   * `productsCount` e `itemsSoldCount` no dependen de este número y los totales
   * de la tarjeta cuadran con los de la lista larga.
   */
  @ApiPropertyOptional({ default: 10, maximum: 2000 })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(2000)
  topProducts?: number;
}
