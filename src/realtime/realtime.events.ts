export const KITCHEN_TICKET_UPDATED = 'kitchen.ticket.updated';
export const TABLE_UPDATED = 'table.updated';
export const ORDER_CLOSED = 'order.closed';

export interface KitchenTicketUpdatedEvent {
  tenantId: string;
  branchId: string;
  ticket: unknown;
}

export interface TableUpdatedEvent {
  tenantId: string;
  branchId: string;
  tableId: string;
  reason: string;
}

export interface OrderClosedEvent {
  tenantId: string;
  branchId: string;
  orderId: string;
  tableId: string;
  totalCOP: number;
}
