import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { AllyTierDto } from './retail-location.dto';

/** Medios con los que se puede cobrar lo vendido. FINANCING queda fuera: congela comisión y giro por venta. */
const COUNT_PAYMENT_METHODS = ['CASH', 'CARD', 'TRANSFER', 'OTHER'] as const;
type CountPaymentMethod = (typeof COUNT_PAYMENT_METHODS)[number];

/**
 * Cómo se cobra lo que la revista descubre vendido. Igual que en el mostrador:
 * por defecto queda POR COBRAR; puede quedar pagada de una vez, o con un abono.
 */
export class CloseRetailStockCountDto {
  @ApiPropertyOptional({
    enum: ['PENDING', 'PAID'],
    description: 'Omitido = PENDING (por cobrar).',
  })
  @IsOptional()
  @IsIn(['PENDING', 'PAID'])
  paymentStatus?: 'PENDING' | 'PAID';

  @ApiPropertyOptional({
    enum: COUNT_PAYMENT_METHODS,
    description: 'Con qué pagó, si queda pagada de una vez.',
  })
  @IsOptional()
  @IsIn(COUNT_PAYMENT_METHODS as unknown as string[])
  paymentMethod?: CountPaymentMethod;

  @ApiPropertyOptional({
    example: 50000,
    description:
      'Abono que deja de una vez. Solo con PENDING y menor a lo que debe.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  depositCOP?: number;

  @ApiPropertyOptional({ enum: COUNT_PAYMENT_METHODS })
  @IsOptional()
  @IsIn(COUNT_PAYMENT_METHODS as unknown as string[])
  depositMethod?: CountPaymentMethod;

  @ApiPropertyOptional({
    description:
      'Cliente al que se le vende. Omitido = el de la bodega (se crea la primera vez).',
  })
  @IsOptional()
  @IsString()
  customerId?: string;
}

/** Asociar a una revista cerrada una venta que ya se había hecho en el mostrador. */
export class LinkRetailStockCountSaleDto {
  @ApiPropertyOptional({ example: 'sale_xxx' })
  @IsString()
  saleId!: string;

  @ApiPropertyOptional({
    description:
      'true = solo calcular qué se corregiría, sin guardar nada.',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    description:
      'Devolver a la bodega lo que la revista ya había sacado y la venta volvió a descontar.',
  })
  @IsOptional()
  @IsBoolean()
  fixInventory?: boolean;
}

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
