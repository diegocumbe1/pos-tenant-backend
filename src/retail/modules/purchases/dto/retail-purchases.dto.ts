import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateRetailPurchaseItemDto {
  @ApiProperty({ example: 'Pijamas beige talla M' })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({
    description:
      'Producto del catálogo, si ya existe. Sin él es mercancía nueva que ' +
      'todavía no está en la tienda.',
  })
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiPropertyOptional({ example: 20, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @ApiPropertyOptional({ example: 'docenas' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  unit?: string;

  @ApiPropertyOptional({ example: 'Distribuidora El Éxito' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  supplier?: string;

  @ApiPropertyOptional({
    example: 16000,
    description: 'Costo unitario estimado',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  estimatedCostCOP?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ description: 'Sube el ítem al principio de la lista' })
  @IsOptional()
  @IsBoolean()
  isUrgent?: boolean;
}

export class UpdateRetailPurchaseItemDto extends PartialType(
  CreateRetailPurchaseItemDto,
) {
  // El enlace al gasto solo se puede escribir en update, no en create: el gasto
  // se registra cuando se paga el pedido, que siempre es después de apuntarlo.
  // `null` desenlaza (el gasto se borró o se enlazó por error); `undefined` lo
  // deja como está. `@IsOptional` ignora los validadores en ambos casos.
  @ApiPropertyOptional({
    nullable: true,
    description: 'Gasto de Finanzas que pagó la mercancía. null desenlaza.',
  })
  @IsOptional()
  @IsString()
  expenseId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Gasto de Finanzas del envío/flete. null desenlaza.',
  })
  @IsOptional()
  @IsString()
  shippingExpenseId?: string | null;
}

/**
 * Marcar un ítem como recibido. Es el único paso que puede tocar el inventario,
 * y solo si el ítem está enlazado a un producto del catálogo.
 */
export class ReceiveRetailPurchaseItemDto {
  @ApiPropertyOptional({
    description:
      'Unidades que realmente llegaron. Por defecto, las que se pidieron.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  quantity?: number;

  @ApiPropertyOptional({
    description:
      'Costo unitario real de la compra; actualiza el costo del producto.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  unitCostCOP?: number;

  @ApiPropertyOptional({
    default: true,
    description:
      'Registra la entrada en el kardex. Se ignora si el ítem no está ' +
      'enlazado a un producto o si el producto no controla stock.',
  })
  @IsOptional()
  @IsBoolean()
  addToInventory?: boolean;

  @ApiPropertyOptional({
    description: 'Nº de factura o remisión del proveedor',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  reference?: string;
}
