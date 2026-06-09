// Mapa evento operativo -> roles que reciben la notificación por defecto.
// Es el "default de sistema". Cuando el admin configure defaults por rol
// (Fase 2: NotificationPreference con roleCode) ese override tendrá prioridad,
// y la preferencia individual del usuario tendrá la última palabra.
export const NOTIFICATION_EVENT_ROLES: Record<string, string[]> = {
  'order.kitchen.new': ['KITCHEN', 'MANAGER', 'OWNER'],
  'kitchen.ticket.ready': ['WAITER', 'CASHIER', 'MANAGER', 'OWNER'],
};

export function rolesForEvent(type: string): string[] {
  return NOTIFICATION_EVENT_ROLES[type] ?? [];
}
