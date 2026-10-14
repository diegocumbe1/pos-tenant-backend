// Mapa evento operativo -> roles que reciben la notificación por defecto.
// Es el "default de sistema". Cuando el admin configure defaults por rol
// (Fase 2: NotificationPreference con roleCode) ese override tendrá prioridad,
// y la preferencia individual del usuario tendrá la última palabra.
export const NOTIFICATION_EVENT_ROLES: Record<string, string[]> = {
  'order.kitchen.new': ['KITCHEN', 'MANAGER', 'OWNER'],
  'kitchen.ticket.ready': ['WAITER', 'CASHIER', 'MANAGER', 'OWNER'],
  // Reserva hecha por el cliente desde el sitio público. Entra pendiente de
  // aprobación: alguien del negocio tiene que verla. Reemplaza el WhatsApp que
  // el negocio se mandaba a sí mismo por cada reserva.
  'barber.appointment.requested': ['OWNER', 'ADMIN', 'MANAGER', 'CASHIER'],
  // Venta registrada por otra persona del equipo (quien la hizo no se avisa).
  'retail.sale.created': ['OWNER', 'ADMIN', 'MANAGER'],
};

export function rolesForEvent(type: string): string[] {
  return NOTIFICATION_EVENT_ROLES[type] ?? [];
}
