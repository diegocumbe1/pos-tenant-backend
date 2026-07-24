import { IsOptional, IsString } from 'class-validator';

// Cancelación de un envío a cocina NO entregado: quita los ítems de ese envío de
// la orden (no se cobran), restaura el stock consumido y anula el ticket.
export class CancelKitchenTicketDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  byUserName?: string;
}
