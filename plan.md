Plan — Backend POS Restaurante
Semana 1 — Productos y Menú
 GET /restaurant/products — catálogo con categorías
 POST /restaurant/products — crear producto
 PATCH /restaurant/products/:id — editar
 DELETE /restaurant/products/:id — soft delete
 PATCH /restaurant/products/:id/toggle — activar/desactivar
 GET /restaurant/categories — listar
 POST /restaurant/categories — crear
 PATCH /restaurant/categories/:id — editar
 DELETE /restaurant/categories/:id — eliminar
Semana 2 — Mesas, Órdenes y POS
 GET /restaurant/areas — áreas del restaurante
 POST /restaurant/areas
 PATCH /restaurant/areas/:id
 DELETE /restaurant/areas/:id
 GET /restaurant/tables — mesas con estado actual
 POST /restaurant/tables
 PATCH /restaurant/tables/:id
 GET /restaurant/orders — órdenes abiertas
 GET /restaurant/orders/:id
 POST /restaurant/orders — crear orden (mesa → PREPARING)
 PATCH /restaurant/orders/:id/items — agregar items
 PATCH /restaurant/orders/:id/kitchen — enviar a cocina
 PATCH /restaurant/orders/:id/payment — solicitar pago
 POST /restaurant/orders/:id/splits — split de pago
 PATCH /restaurant/orders/:id/close — cerrar cuenta (mesa → AVAILABLE)
Semana 3 — Kitchen Display + WebSocket
 GET /restaurant/kitchen/tickets
 PATCH /restaurant/kitchen/tickets/:id/status
 WebSocket: kitchen:ticket:updated
 WebSocket: table:updated
 WebSocket: order:closed
Semana 4 — Finance + Reservas + Auth real
 GET /finance/dashboard
 GET /finance/expenses
 GET /finance/payroll
 GET /finance/goals
 POST /restaurant/reservations
 GET /restaurant/reservations
 PATCH /restaurant/reservations/:id
 PATCH /restaurant/reservations/:id/seat
 PATCH /restaurant/reservations/:id/cancel
 JWT/Clerk guards en producción
