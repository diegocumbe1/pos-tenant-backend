import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { OrderItemDto } from './create-order.dto';

export class AddItemsDto {
  @IsArray()
  // Con replacePending el payload representa el set COMPLETO de ítems pendientes,
  // por lo que puede venir vacío (el mesero quitó todo lo no enviado a cocina).
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  // Cuando es true, el backend reconcilia los ítems pendientes (sentQty === 0):
  // los que NO vengan en `items` se eliminan de la orden. Los ítems ya enviados
  // a cocina (sentQty > 0) nunca se tocan. Sin este flag, la semántica es
  // aditiva/merge (comportamiento por defecto para envío a cocina, pago, cierre).
  @IsOptional()
  @IsBoolean()
  replacePending?: boolean;
}

export { OrderItemDto };
