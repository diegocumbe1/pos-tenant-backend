import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { RetailPurchaseVarianceResolution } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateRetailPurchaseItemDto {
  @ApiPropertyOptional({
    description:
      'Ficha del proveedor. Si se omite y viene `supplier`, se busca por ' +
      'nombre y se crea la ficha si no existe.',
  })
  @IsOptional()
  @IsString()
  supplierId?: string;

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

// Los enlaces a gastos NO se escriben por aquí: un pedido acumula varios pagos
// y mandar la lista completa en cada edición haría que dos líneas hermanas
// guardadas a la vez se pisen los pagos entre sí. Van por su propio endpoint,
// que agrega o quita de a uno.
export class UpdateRetailPurchaseItemDto extends PartialType(
  CreateRetailPurchaseItemDto,
) {}

/** Mercancía y flete se pagan por separado y se miran por separado. */
export const PURCHASE_EXPENSE_KINDS = ['GOODS', 'SHIPPING'] as const;
export type PurchaseExpenseKind = (typeof PURCHASE_EXPENSE_KINDS)[number];

/**
 * Enlaza un gasto ya registrado en Finanzas a este pedido. Es idempotente: el
 * mismo gasto dos veces no lo duplica, porque el frontend enlaza en paralelo
 * todas las líneas de un pedido conjunto y un reintento no debe contar doble.
 */
export class LinkPurchaseExpenseDto {
  @ApiProperty({ description: 'Id del gasto en Finanzas' })
  @IsString()
  @MinLength(1)
  expenseId!: string;

  @ApiProperty({ enum: PURCHASE_EXPENSE_KINDS, default: 'GOODS' })
  @IsOptional()
  @IsIn(PURCHASE_EXPENSE_KINDS)
  kind?: PurchaseExpenseKind;
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

  @ApiPropertyOptional({
    example: 12,
    description:
      'Cuántas de las que llegaron DE MÁS se van a pagar. El resto se toma ' +
      'como error del proveedor: entran al inventario con costo 0, en su propio ' +
      'movimiento de kardex, y no generan deuda. Omitirlo = se pagan todas, que ' +
      'era el comportamiento anterior. Va como cantidad y no como un sí/no ' +
      'porque el reparto real no es todo-o-nada: de 16 de más se pueden acordar ' +
      '12 y dejar 4 como error.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  overagePaidQty?: number;

  @ApiPropertyOptional({
    description:
      'Qué pasó, cuando llegó una cantidad distinta a la pedida. Solo se ' +
      'guarda si hay diferencia.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  varianceNote?: string;
}

/** Cierra la línea con lo que haya llegado: "no llega más". */
export class CloseRetailPurchaseItemDto {
  @ApiPropertyOptional({ example: 'El proveedor confirmó que no repone' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/**
 * En qué queda un faltante o un sobrante.
 *
 * Va aparte de recibir a propósito: al descargar las cajas todavía no se sabe si
 * el proveedor va a reponer, descontar o nada. Se resuelve después, cuando el
 * proveedor contesta, y hasta entonces la línea queda en PENDING — que es lo que
 * hace que aparezca como cuenta abierta.
 */
export class ResolveRetailPurchaseVarianceDto {
  @ApiProperty({ enum: RetailPurchaseVarianceResolution, example: 'REORDERED' })
  @IsEnum(RetailPurchaseVarianceResolution)
  resolution!: RetailPurchaseVarianceResolution;

  @ApiPropertyOptional({ example: 'Lo reponen en el pedido de octubre' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
