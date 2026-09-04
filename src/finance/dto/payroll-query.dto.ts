import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/**
 * A diferencia del resto de finanzas (today/week/month), la nómina se consulta
 * por MES calendario en formato YYYY-MM. Default: mes actual.
 */
export class PayrollQueryDto {
  @ApiPropertyOptional({
    description: 'Mes de nómina YYYY-MM',
    example: '2026-07',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/, { message: 'period must be YYYY-MM' })
  period?: string;
}
