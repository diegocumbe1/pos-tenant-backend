import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

// Una opción de modificador elegida para un ítem (p. ej. "Término: medio",
// "Extra queso"). El precio se refleja en `priceCOP` del ítem; aquí guardamos el
// delta solo con fines de auditoría/impresión. La forma espeja `MenuModifierOption`
// del frontend (verticals/restaurant/types/order.types.ts).
export class ModifierOptionDto {
  @IsString()
  id: string;

  @IsString()
  label: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsNumber()
  priceDeltaCOP?: number;
}

export class OrderItemDto {
  // Identidad de la LÍNEA (no del producto). Permite el mismo producto en
  // varias líneas con distintas notas/opciones. Lo genera el frontend
  // (`${productId}-${timestamp}`). Si no viene, el backend usa `productId`
  // como clave (compatibilidad hacia atrás con clientes antiguos).
  @IsOptional()
  @IsString()
  lineKey?: string;

  @IsString()
  productId: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceCOP?: number;

  @IsInt()
  @Min(1)
  qty: number;

  // Nota libre del mesero para este ítem (p. ej. "sin cebolla").
  @IsOptional()
  @IsString()
  notes?: string;

  // Agregados simples como texto (p. ej. ["extra queso", "doble carne"]).
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  additions?: string[];

  // Opciones de modificadores estructuradas elegidas para el ítem.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ModifierOptionDto)
  modifiers?: ModifierOptionDto[];
}

export class CreateOrderDto {
  @IsString()
  tableId: string;

  @IsOptional()
  @IsString()
  waiterId?: string;

  @IsOptional()
  @IsString()
  terminalId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[];
}
