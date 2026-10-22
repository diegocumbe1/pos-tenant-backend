import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { AllyTierDto } from './retail-location.dto';

export class StockCountLineInputDto {
  @IsString()
  lineId!: string;

  @ApiPropertyOptional({
    example: 3,
    nullable: true,
    description:
      'Lo contado. null = no se tocó, cuenta como igual a lo esperado.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  countedQty!: number | null;
}

export class UpdateRetailStockCountDto {
  @ApiPropertyOptional({ type: [StockCountLineInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => StockCountLineInputDto)
  lines?: StockCountLineInputDto[];

  @ApiPropertyOptional({
    example: 'Quedó de pagar el viernes',
    nullable: true,
    description:
      'Notas de la revista: acuerdos, compromisos de pago, lo que se vio.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class UpdateAllySettingsDto {
  @ApiPropertyOptional({
    type: [AllyTierDto],
    description:
      'Escalas estándar de los aliados. [] = sin descuento. Una sola escala ' +
      'también vale (p. ej. [{ aboveCOP: 0, pct: 15 }]).',
  })
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AllyTierDto)
  allyTiers!: AllyTierDto[];
}
