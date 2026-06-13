# MVP QA Test Cases

> Objetivo: validar el MVP con login real (`authMode='api'`) y cero dependencia de datos demo. Backend ya confirmó el Anexo A7; estos casos sirven para implementar y probar el write-through del Bloque 1 en Frontend.

## Faltante Frontend para poder probar end-to-end

| Área | Falta FE | Cómo se valida |
|---|---|---|
| Sesión API | Selección de sede + terminal al entrar en `authMode='api'`. | Requests llevan `X-Tenant-Id`, `X-Branch-Id` y las mutaciones usan `terminalId` real. |
| POS write-through | Acciones del `posStore` deben llamar API en modo `api`. | Abrir orden, modificar ítems, enviar cocina, pagar y cerrar sobreviven refresh. |
| Reconciliación | Re-hidratar después de mutaciones para usar ids del servidor. | No quedan ids temporales ni órdenes duplicadas tras polling/refresh. |
| Pago/cierre | Separar `PATCH /payment` antes de `PATCH /close`. | `/close` falla si no existe `PaymentSplit`; con pago previo libera mesa y genera venta. |
| KDS | Avanzar tickets con `PATCH /restaurant/kitchen/tickets/:id/status`. | KDS y POS reflejan `PREPARING` → `READY` → `SERVED`. |
| Demo guardrails | Asegurar que modo API no escribe claves demo. | DevTools/localStorage no muestra escrituras `lynko:demo:*` durante operación real. |
| Permisos | Ocultar rutas/acciones según `apiProfile.permissions`. | Roles cajero/cocina ven únicamente lo permitido. |
| Histórico | Mostrar/consumir `events.metadata` en ventas cuando aplique. | Timeline permite auditar cambios de ítems, cocina, pago y cierre. |
| Notificaciones | Conectar campana a `GET /notifications/events` y registrar Web Push. | Feed persistido, contador y suscripción sobreviven refresh/login real. |

## Payloads A7 confirmados

```http
POST /restaurant/orders
{
  "tableId": "table_id",
  "terminalId": "terminal_1",
  "waiterId": "user_id",
  "items": [{ "productId": "product_id", "qty": 1 }]
}
```

```http
PATCH /restaurant/orders/:id/items
{
  "items": [
    { "productId": "product_id_1", "qty": 2 },
    { "productId": "product_id_2", "qty": 1 }
  ]
}
```

`PATCH /restaurant/orders/:id/items` es **set deseado completo**. No mandar solo el delta.

```http
PATCH /restaurant/orders/:id/kitchen
{}
```

```http
PATCH /restaurant/kitchen/tickets/:id/status
{ "status": "PREPARING" }
```

```http
PATCH /restaurant/orders/:id/payment
{
  "contributions": [
    { "method": "cash", "amount": 20000 },
    { "method": "card", "amount": 15000, "cardType": "debit" }
  ],
  "items": [
    { "productId": "product_id_1", "name": "Producto", "qty": 2, "priceCOP": 10000 },
    { "productId": "product_id_2", "name": "Producto 2", "qty": 1, "priceCOP": 15000 }
  ],
  "totalCOP": 35000
}
```

La suma de `contributions.amount` y el total de `items` deben ser iguales a `totalCOP`.

```http
PATCH /restaurant/orders/:id/close
{
  "terminalId": "terminal_1",
  "cashSessionId": "cash_session_id"
}
```

`cashSessionId` es opcional; si no se envía, Backend busca caja abierta por tenant/branch/terminal.
`/close` valida que los pagos registrados sumen el total real de la orden.

## Datos previos

- Usuario real con tenant restaurante, sede y terminal asignadas.
- Productos, áreas y mesas creados desde seed/API.
- `NEXT_PUBLIC_DATA_MODE=api`.
- Navegador con `localStorage` limpio o recién pasado por login real/logout.

## Smoke API

| Caso | Pasos | Resultado esperado |
|---|---|---|
| Login real | Entrar con email/clave reales. | Sesión queda en `authMode='api'`; no aparece badge Demo; `GET /auth/me` carga tenant, branch, rol y permisos. |
| Demo aislado | Entrar a demo, generar datos, hacer logout/login real. | El login real limpia claves demo y no hidrata datos mock. |
| Sede/terminal | Seleccionar sede y terminal al entrar. | Requests reales envían tenant/branch correctos y la terminal queda disponible para órdenes/caja. |

## POS Restaurante

| Caso | Pasos | Resultado esperado |
|---|---|---|
| Cargar POS | Abrir pantalla POS tras login real. | Mesas, áreas y órdenes abiertas vienen de API; sin datos mock. |
| Abrir orden | Seleccionar mesa libre y crear orden. | BE devuelve `Order` con id servidor; mesa pasa a ocupada tras re-hidratación. |
| Agregar ítems | Agregar productos a la orden enviando el set completo. | `PATCH /orders/:id/items` persiste ítems; total coincide con UI. |
| Enviar cocina | Enviar orden a cocina. | Se crea ticket KDS; `sentQty` queda reconciliado; inventario se descuenta si aplica. |
| KDS status | Cambiar ticket a preparando, listo y servido. | Estado persiste en API y POS/KDS se mantienen sincronizados. |
| Pago parcial/split | Registrar pagos por método hasta completar total. | `paymentSplits` persisten; remaining llega a 0. |
| Cerrar orden | Registrar `PATCH /payment` y luego `PATCH /close`. | Orden queda `CLOSED`, mesa libre, venta aparece en Finanzas, recibo disponible. |
| Cierre sin pago | Intentar `PATCH /close` sin `PATCH /payment`. | API responde error 422; UI no libera mesa ni crea venta falsa. |

## Histórico y Métricas

| Caso | Pasos | Resultado esperado |
|---|---|---|
| Línea nueva | Crear orden y agregar producto nuevo. | `events` contiene `ITEM_ADDED` con `metadata.productId`, `previousQty=0`, `newQty`, `deltaQty`. |
| Cambio de cantidad | Cambiar cantidad de un producto antes de enviarlo. | `events` contiene `ITEM_UPDATED` con `previousQty`, `newQty`, `deltaQty`. |
| Remover línea | Quitar producto no enviado a cocina. | `events` contiene `ITEM_REMOVED` con `newQty=0` y `deltaQty` negativo. |
| Protección cocina | Intentar reducir/quitar línea ya enviada por debajo de `sentQty`. | API responde error 422 y no crea evento inválido. |
| Envío cocina | Enviar a cocina. | `SENT_TO_KITCHEN.metadata.items[]` refleja solo el delta enviado. |
| Estados KDS | Pasar ticket por `PREPARING`, `READY`, `SERVED`. | Eventos de cocina guardan `metadata.fromStatus` y `metadata.toStatus`. |
| Pago | Registrar split. | `PAYMENT_REGISTERED.metadata` guarda contribuciones, items y total. |
| Cierre | Cerrar orden. | `CLOSED.metadata` guarda total, terminal, caja/splits cuando aplique. |
| Rotación mesa | Repetir apertura/cierre en la misma mesa. | Cada ocupación genera venta independiente sin mezclar ítems/pagos. |

## Finanzas y Caja

| Caso | Pasos | Resultado esperado |
|---|---|---|
| Histórico diario | Abrir Finanzas/Ventas tras cerrar órdenes. | Ventas del día muestran total, métodos, tiempos, timeline y recibo. |
| Reclamo | Registrar reclamo en orden/venta. | Reclamo persiste con severidad minúscula y aparece en historial. |
| Abrir/cerrar caja | Abrir caja, operar, cerrar caja. | Movimientos incluyen ventas; resumen cuadra con pagos. |
| Caja estricta | Intentar cerrar orden sin caja si BE activa modo estricto. | API responde `409 NO_OPEN_CASH_SESSION`; UI guía a abrir caja. |

## Permisos

| Caso | Pasos | Resultado esperado |
|---|---|---|
| Cajero | Login con rol cajero. | Ve POS/caja permitidos; no ve pantallas restringidas. |
| Cocina | Login con rol cocina. | Ve KDS; no puede cobrar ni abrir settings sensibles. |
| Vertical | Login tenant restaurante/barber. | La UI no muestra permisos ni secciones de la otra vertical. |

## Barbería

| Caso | Pasos | Resultado esperado |
|---|---|---|
| Finanzas barber | Abrir `/barber/finance` cuando esté implementado. | KPIs y ventas provienen de API, no de mock. |
| Arqueo barber | Abrir/cerrar caja para barbería. | Reusa cash sessions sin acoplarse a restaurante. |

## Checks técnicos

- No deben aparecer escrituras a claves `pos-demo-*`, `sales-history-*`, `printers-*`, `cash-sessions-*` ni `lynko:demo:*` durante `authMode='api'`.
- Las respuestas epoch ms de orders/kitchen se muestran como fechas ISO/legibles en UI.
- Después de refrescar navegador, el estado visible debe reconstruirse desde API.
- `next build`, `tsc` y `eslint` verdes antes de marcar el bloque como listo.

## Backoffice de plataforma (`/platform/*`, API real)

> Requiere un platform admin real (`admin@uselynko.com` o `noreply@uselynko.com`, creados con
> `npm run bootstrap:root`). NO se envía `X-Tenant-Id`. Ver `docs/BACKOFFICE_ARCHITECTURE.md` §3/§10.

| Caso | Pasos | Resultado esperado |
|---|---|---|
| Login super-admin | `POST /auth/login` con el admin → `GET /auth/me`. | `isPlatformAdmin: true`; el FE deja entrar a `/admin`. |
| Rechazo no-admin | Login con un usuario de tenant → entrar a `/admin`. | `GET /auth/me` trae `isPlatformAdmin:false`; el FE cierra sesión / no autoriza. |
| Guard sin claim | Llamar `GET /platform/tenants` con token de usuario de tenant. | `403 { code: 'NOT_PLATFORM_ADMIN' }`. |
| Listar negocios | `GET /platform/tenants`. | Lista real con `status`, `subscription`, `usersCount`, `branchesCount`. |
| Usuarios reales | `GET /platform/tenants/:id/users`. | Usuarios del tenant con rol/estado; `ADMIN`→`ADMINISTRATIVE`. |
| Habilitar/deshabilitar usuario | `PATCH /platform/users/:id/status {status:'DISABLED'}`. | `User.isActive=false`; ese usuario recibe `403 USER_DISABLED` al hacer login. |
| Switch suscripción | `POST /platform/tenants/:id/subscription/suspend`. | Suscripción `SUSPENDED` + `tenant.status=SUSPENDED`; usuarios del tenant → `403 ACCOUNT_INACTIVE` al login. `activate` lo revierte. |
| Crear suscripción faltante | Suspender/activar un tenant sin suscripción previa. | El BE la crea (upsert) y aplica el estado; no falla con NotFound. |
| Cambiar plan | `PATCH /platform/tenants/:id/plan {plan:'PREMIUM'}`. | `tenant.plan` y `subscription.plan` = PREMIUM; auditado. |
| Override de módulo | `PATCH /platform/tenants/:id/features {feature:'inventory',value:true}`. | `GET /platform/tenants/:id` → `features.inventory=true`; `value:null` lo quita. |
| Registrar pago | `POST /platform/tenants/:id/payments {amount,periodStart,periodEnd}`. | Pago creado; con `extendPeriod` (default) mueve `currentPeriodEnd` y reactiva. |
| Pago anticipado | `POST .../payments` con `periodEnd` varios meses adelante. | Aparece en `GET .../payments` cubriendo el periodo futuro; suscripción al día. |
| Histórico por mes | `GET /platform/payments?month=YYYY-MM`. | Pagos del mes (todos los tenants) con `tenantName`. |
| Overview | `GET /platform/overview`. | `tenants{total,byStatus}`, `subscriptions{byStatus,mrrCOP,mrrUSD}`, `payments{month,count,totalAmount}`. |
| Auditoría | Tras cualquier mutación, revisar `platform_audit_logs`. | Fila con `actorUserId`, `action`, `before`→`after`. |

## Notificaciones Web/PWA

| Caso | Pasos | Resultado esperado |
|---|---|---|
| Manifest PWA | Abrir `/manifest.webmanifest`. | Responde 200 y la app es instalable cuando el navegador lo soporte. |
| Service worker | Abrir `/sw.js`. | Responde 200; FE puede registrar service worker. |
| Crear evento in-app | `POST /notifications/events` con `type`, `title`, `payload`. | Devuelve evento `DELIVERED`, `channel=IN_APP`, visible en `GET /notifications/events`. |
| Feed persistido | Refrescar navegador y consultar feed. | La notificación sigue disponible desde backend; no depende de estado local. |
| Marcar leído | `PATCH /notifications/events/:id/read`. | `readAt` queda seteado y baja `unreadCount`. |
| Marcar todos | `POST /notifications/events/read-all`. | Las notificaciones del usuario/sede quedan leídas. |
| Preferencias | `POST /notifications/preferences` para `appointment.created` o `kitchen.ticket.ready`. | `GET /notifications/preferences` devuelve canales y quiet hours. |
| Guardar Web Push | `POST /notifications/web-push/subscriptions` con `endpoint` y `keys`. | Backend guarda/actualiza dispositivo activo del usuario. |
| Desactivar Web Push | `DELETE /notifications/web-push/subscriptions/:id`. | Suscripción queda `isActive=false` y deja de listarse como activa. |
| Límite MVP | Intentar esperar envío push automático. | No se promete todavía: falta worker/proveedor VAPID + cola. |
