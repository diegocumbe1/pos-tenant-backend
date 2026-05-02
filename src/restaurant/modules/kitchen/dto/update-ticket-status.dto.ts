import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const KITCHEN_TICKET_STATUSES = [
  'PENDING',
  'PREPARING',
  'READY',
  'SERVED',
] as const;

export type KitchenTicketStatus = (typeof KITCHEN_TICKET_STATUSES)[number];

export class UpdateTicketStatusDto {
  @ApiProperty({ enum: KITCHEN_TICKET_STATUSES })
  @IsIn(KITCHEN_TICKET_STATUSES as unknown as string[])
  status!: KitchenTicketStatus;
}
