# Plan de migración: whatsapp-web.js → Meta WhatsApp Cloud API

> Estado: **propuesta para revisión**. No hay código, commits, migraciones ni
> cambios de dependencias asociados a este documento.
>
> Fecha de la auditoría: 2026-10-07 · rama `demo` · commit base `5ab8818`.
>
> Sobre los datos de Meta: lo que se dice de Cloud API (endpoints, ventana de 24 h,
> categorías de plantilla, Embedded Signup, límites, precios) refleja la
> documentación pública conocida a la fecha de redacción. **Antes de cada fase
> que toque Meta hay que verificarlo contra developers.facebook.com**, porque Meta
> cambia versiones de Graph, precios y requisitos de onboarding con frecuencia.
> Esos puntos están marcados con 🔎.

---

## Resumen ejecutivo

1. **Ya existe media abstracción.** Hay una interfaz `IMessagingProvider`
   (envíos del tenant) y otra `IPlatformChannelSender` (envíos de Lynko). Pero
   tres sitios todavía usan el `Client` de whatsapp-web.js directamente: el canal
   de plataforma, el agente del asistente y el session manager. La migración
   puede montarse sobre lo que hay, sin reescribir.
2. **No hay schedulers, colas ni crons de WhatsApp.** Todo envío nace de una
   petición HTTP: el frontend al crear una cita, un clic del cajero o un clic del
   super-admin. O el agente responde a un mensaje entrante. El caso de "el
   scheduler corre 4 veces" todavía no existe. Sí existe su equivalente: el
   frontend repite la llamada.
3. **El hallazgo más grave no tiene que ver con Cloud API.** El controller
   `/whatsapp/*` **no tiene ningún guard de autenticación**. Resuelve el tenant
   desde headers con fallback a IDs de demo. Cualquiera que conozca la URL puede
   hacer esto con la sesión de cualquier tenant, **incluida la del número de
   Lynko** (`__platform__`):
   - mandar texto libre a cualquier número (`POST /whatsapp/test`);
   - ver el QR de emparejamiento;
   - desconectar la sesión.

   El código no permite demostrar que esto se haya explotado, ni que causara el
   "Account in review". Pero es exactamente el tipo de superficie que convierte
   un número en un relé de spam, y debe cerrarse antes que nada (ver §8, R1).
4. **Cloud API cambia el producto, no solo el transporte.** Hoy el dueño redacta
   libremente el texto de cada aviso (`WhatsappTemplate.body`). En Cloud API,
   todo mensaje que inicia el negocio fuera de la ventana de 24 h tiene que ser
   una **plantilla aprobada por Meta**, con variables posicionales. El editor de
   textos del tenant tendrá que convertirse en "elegir plantilla aprobada +
   encender/apagar".

---

## 1. Arquitectura actual encontrada

```
                         ┌──────────────────────────────────────────┐
                         │ WhatsAppModule (src/whatsapp)             │
 Frontend (tenant) ─────►│  WhatsAppController  /whatsapp/*  ⚠ sin auth
   citas, pedidos,       │     │                                     │
   medios de pago, test  │     ▼                                     │
                         │  WhatsAppService ──► IMessagingProvider ──┼─► WhatsAppWebJsProvider
                         │     │ (render)          (MESSAGING_PROVIDER)│        │
                         │  WhatsappTemplatesService ◄── WhatsappTemplatesController (JWT ✓)
                         │                                           │        ▼
                         │  WhatsAppSessionManager ◄─────────────────┼── Client (whatsapp-web.js)
                         │   · Map<tenant:branch, Client+Chromium>   │   + RemoteAuth
                         │   · restore-on-boot, backup, QR, eventos  │   + StorageRemoteAuthStore
                         └──────┬───────────────▲────────────────────┘        │
            EventEmitter2       │'wa.message'   │ getClient() directo         ▼
            'wa.status'         ▼               │                  Supabase Storage (zip ~30MB)
                         ┌──────────────────────┴─────┐            + whatsapp_sessions (índice)
                         │ AssistantModule            │
                         │  WhatsAppInboundService    │  (solo sesión __platform__)
                         │   → LynkoAgentService      │
                         └────────────────────────────┘
                         ┌────────────────────────────┐
 Backoffice (super- ────►│ PlatformMessagingModule    │
   admin, JWT+Platform   │  MessageSenderService      │
   AdminGuard ✓)         │   → IPlatformChannelSender │──► WhatsAppPlatformChannel ──► getClient() directo
                         │   → EmailPlatformChannel   │    (importa MessageMedia de whatsapp-web.js)
                         │  PlatformMessage (historial)│
                         └────────────────────────────┘
```

Qué está bien resuelto:

- **Sesiones separadas.** La sesión de Lynko es el par sentinel
  `('__platform__', '__platform__')` y las de los tenants son
  `(tenantId, branchId)`. Las dos viven en el mismo motor.
- **El agente solo escucha la sesión de la plataforma.** Ignora los mensajes de
  las sesiones de tenants sin siquiera registrarlos.
- **El canal de plataforma ya está pensado como puerto.** El comentario de
  `channel.interface.ts` dice textualmente que "WhatsApp Cloud API entraría como
  otra implementación de esto".
- **El historial de plataforma (`PlatformMessage`) ya reservó campos**
  (`dedupeKey @unique`, `jobKey`, `scheduledFor`) para cuando haya automatización.

## 2. Archivos relacionados con WhatsApp

### Núcleo (whatsapp-web.js)

| Archivo | Rol |
|---|---|
| [src/whatsapp/whatsapp-session.manager.ts](../src/whatsapp/whatsapp-session.manager.ts) | Motor de sesiones: crea/destruye `Client`, QR, eventos `ready/authenticated/disconnected/auth_failure/change_state/message_create`, restore-on-boot, backup al apagar, cupos. **Importa `Client, Message, RemoteAuth`.** |
| [src/whatsapp/storage-remote-auth.store.ts](../src/whatsapp/storage-remote-auth.store.ts) | Store de `RemoteAuth` sobre Supabase Storage (bucket privado). `delete()` es no-op a propósito. |
| [src/whatsapp/providers/messaging-provider.interface.ts](../src/whatsapp/providers/messaging-provider.interface.ts) | Puerto `IMessagingProvider` (`sendText`, `isReady`). |
| [src/whatsapp/providers/whatsapp-webjs.provider.ts](../src/whatsapp/providers/whatsapp-webjs.provider.ts) | Adaptador web.js del puerto: `getNumberId` + `sendMessage`. |
| [src/whatsapp/whatsapp.service.ts](../src/whatsapp/whatsapp.service.ts) | Casos de uso del tenant: cita (negocio/cliente), pedido (negocio/cliente), medios de pago, envío crudo. |
| [src/whatsapp/whatsapp.controller.ts](../src/whatsapp/whatsapp.controller.ts) | Endpoints `/whatsapp/session/*`, `/whatsapp/appointments/*`, `/whatsapp/orders/*`, `/whatsapp/payment-methods`, `/whatsapp/test`. **Sin guards.** SSE de estado. |
| [src/whatsapp/whatsapp-templates.controller.ts](../src/whatsapp/whatsapp-templates.controller.ts) / [whatsapp-templates.service.ts](../src/whatsapp/whatsapp-templates.service.ts) | Textos editables por el tenant (JWT + TenantGuard + permisos ✓). |
| [src/whatsapp/templates/message-templates.ts](../src/whatsapp/templates/message-templates.ts), `appointment.templates.ts`, `payment-methods.template.ts` | Defaults y render de tokens `{cliente}`, `{fecha}`… |
| [src/whatsapp/whatsapp.module.ts](../src/whatsapp/whatsapp.module.ts) | Cablea `MESSAGING_PROVIDER → WhatsAppWebJsProvider`; exporta el session manager. |

### Plataforma (WhatsApp de Lynko)

| Archivo | Rol |
|---|---|
| [src/platform-messaging/channels/whatsapp.channel.ts](../src/platform-messaging/channels/whatsapp.channel.ts) | Envío por el número de Lynko. **Importa `MessageMedia`** y usa el `Client` directamente. |
| [src/platform-messaging/channels/channel.interface.ts](../src/platform-messaging/channels/channel.interface.ts) | Puerto `IPlatformChannelSender`. |
| [src/platform-messaging/services/message-sender.service.ts](../src/platform-messaging/services/message-sender.service.ts) | Preview + envío manual, tolerante por canal, registra `PlatformMessage`. |
| [src/platform-messaging/platform-messaging.controller.ts](../src/platform-messaging/platform-messaging.controller.ts) | Consola super-admin: pair/disconnect del número de Lynko, plantillas, envío (JWT + PlatformAdminGuard ✓). |
| `platform-messaging.constants.ts`, `phone.util.ts`, `seed-templates.ts`, `template-variables.ts`, `services/*` | Sentinel de sesión, normalización `57…`, plantillas sembradas (cobro, mora, etc.). |

### Asistente (recepción)

| Archivo | Rol |
|---|---|
| [src/assistant/channels/whatsapp-inbound.service.ts](../src/assistant/channels/whatsapp-inbound.service.ts) | `@OnEvent('wa.message')`: filtra, agrupa ráfagas, llama al agente y responde. **Usa `getClient()`, `getChatById`, `sendSeen`, `sendStateTyping`, `sendMessage` directamente.** |
| [src/assistant/channels/whatsapp-agent.controller.ts](../src/assistant/channels/whatsapp-agent.controller.ts) | Diagnóstico y simulación sin envío (super-admin ✓). |
| [src/assistant/conversation/conversation.service.ts](../src/assistant/conversation/conversation.service.ts) | Contexto por (canal, teléfono); "human takeover" depende de que web.js emita `message_create` para lo escrito a mano. |

### Persistencia, scripts e infraestructura

| Elemento | Detalle |
|---|---|
| `prisma/schema.prisma` | `WhatsappSession`, `WhatsappTemplate` (+ enum `WhatsappTemplateKey`), `PlatformMessage*`, `PlatformMessagingSettings` (`waEnabled`, `agentEnabled`), `AssistantConversation`. |
| Migraciones | `20260725220919_whatsapp_session_persistence`, `20260806120000_platform_messaging`, `20260806150000_whatsapp_session_to_storage`, `20260914120000_whatsapp_templates`, `20260922120000_assistant_whatsapp_agent`. |
| [scripts/migrate-wa-session-to-storage.ts](../scripts/migrate-wa-session-to-storage.ts) | Migración one-shot del blob de sesión de Postgres a Storage (ver §6). |
| [src/main.ts](../src/main.ts) | `enableShutdownHooks()` (para el backup final), `rawBody: true` (útil para validar firmas de webhook de Meta). |
| `Dockerfile` | Instala Chromium y sus librerías en la imagen de runtime (solo existe por web.js). |
| `railway.json` | Healthcheck `/api/v1/health/ready`, `restartPolicyType: ON_FAILURE`, `maxRetries: 10`. |
| `.wwebjs_cache/`, `.wa-sessions/` | Caches locales de web.js (sin trackear en git). |
| `src/platform/plans/plan-features.ts` | Flag `whatsappReminders` por plan. **No se usa en ningún sitio.** |
| `src/notifications/*` | Preferencia `whatsapp` por usuario. **Se guarda, pero ningún dispatcher envía por WhatsApp.** |
| Frontend (`pos-system`) | `hooks/use-whatsapp-session.ts`, `verticals/barber/services/appointment.service.ts`, `components/barber/public-booking/BookingConfirmation.tsx` (**página pública, sin login**), `components/barber/NewAppointmentModal.tsx`, `app/barber/appointments/*`, `components/payments/share-payment-methods-dialog.tsx`. |

## 3. Flujo actual de autenticación

1. El frontend llama `POST /whatsapp/session/pair` con `X-Tenant-Id`/`X-Branch-Id`
   (o el backoffice llama `POST /platform/messaging/channels/whatsapp/pair`).
2. `pair()` verifica cupos (`WA_MAX_ACTIVE_SESSIONS`) y crea un `Client` con:
   - `RemoteAuth` + `StorageRemoteAuthStore`;
   - `webVersion` fijada (`WA_WEB_VERSION`, caduca ~11-nov-2026 según el comentario);
   - `takeoverOnConflict: true`;
   - Chromium headless.
3. Timeouts: si no llega QR en `WA_PAIR_TIMEOUT_MS`, `error` y se destruye el
   cliente. Si llega `authenticated` pero no `ready` en `WA_READY_TIMEOUT_MS`,
   pasa lo mismo.
4. `qr` → se convierte a data URL y se emite `wa.status`. El frontend la recibe
   por SSE (`/whatsapp/session/stream`) o por polling (backoffice).
5. `ready` → se guarda `phoneNumber` en `whatsapp_sessions` (upsert).
6. RemoteAuth sube el zip del perfil a Storage ~60 s después de `ready` y luego
   cada `WA_BACKUP_SYNC_MS` (30 min por defecto).
7. `disconnected`:
   - Con `LOGOUT`/`UNPAIRED`/`UNPAIRED_IDLE` se purga el zip, la fila y las
     carpetas locales.
   - Con cualquier otro motivo (incluido `CONFLICT`) solo se destruye el cliente
     en memoria. **No hay reconexión automática**: la sesión queda caída hasta el
     siguiente boot o hasta un `pair` manual.

## 4. Flujo actual de envío

**Tenant → cliente final** (citas, pedidos, medios de pago):

```
Frontend ──HTTP──► WhatsAppController (sin auth; tenant de headers o DEMO)
                 ► WhatsAppService.sendTemplate()
                     · render del texto del tenant (o default); null = apagado → skipped
                 ► IMessagingProvider.sendText()  (WhatsAppWebJsProvider)
                     · isReady? → getNumberId(phone) → client.sendMessage()
```

- Disparadores:
  - Cita creada en el POS: `NewAppointmentModal`, fire-and-forget.
  - Botón "enviar WhatsApp" en las listas de citas (manual, repetible).
  - **Confirmación de reserva pública:** `BookingConfirmation`, desde el
    navegador del cliente final, que llama a cliente **y** negocio.
  - "Compartir medios de pago" del cajero.
- `orders/notify-*` existen en backend, pero no encontré ningún llamador en el
  frontend.
- **No hay registro** de los mensajes enviados por tenants: ni tabla, ni
  idempotencia, ni historial.

**Lynko → dueño del tenant** (cobros, recordatorios):

```
Backoffice ──HTTP (JWT + PlatformAdmin)──► MessageSenderService.preview()/send()
   · resuelve destinatario, plantilla (payment_reminder ↔ payment_overdue), canal OK
   ► WhatsAppPlatformChannel.send()  → getNumberId → sendMessage (+ imagen QR como caption, + PDF)
   ► PlatformMessage (SENT/FAILED/SKIPPED, texto exacto, providerId)
```

- 100 % manual ("Todo envío es MANUAL: no hay scheduler").
- `PlatformMessagingSettings.waEnabled` existe en la base y en el DTO, pero
  **ningún envío lo consulta**.

**Agente → usuario** (respuestas):

```
wa.message → WhatsAppInboundService → debounce 3s → LynkoAgentService.process()
           → sendSeen + typing + pausa ≤6s → client.sendMessage(chatId)
```

## 5. Flujo actual de recepción

- El session manager escucha `message_create` en **todas** las sesiones (entrante
  y saliente, incluido lo escrito a mano desde el celular). Resuelve el teléfono
  real cuando el chat es `@lid` y emite `wa.message` por `EventEmitter2`.
- Único consumidor: `WhatsAppInboundService`. Solo atiende la sesión
  `WA_AGENT_TENANT_ID/WA_AGENT_BRANCH_ID` (default `__platform__`). Se puede
  apagar desde la consola (`agentEnabled`, en caché 15 s).
- Descarta grupos, broadcast, newsletter y mensajes sin texto. Agrupa ráfagas,
  tiene un tope de 200 chats pendientes y trunca a 1000 caracteres.
- "Human takeover": si sale un mensaje que el agente no envió (en los últimos
  30 s, con el mismo texto), el chat se silencia `WA_AGENT_HUMAN_TAKEOVER_HOURS`.
- Los mensajes que entran a sesiones de tenants se emiten como evento y se
  descartan; no se procesan.

## 6. Cómo se almacenan las sesiones

| Capa | Qué guarda |
|---|---|
| Supabase Storage, bucket privado (`SUPABASE_PRIVATE_BUCKET`, default `lynko-private`) | `whatsapp-sessions/<clientId>.zip` (~30 MB, perfil completo de Chromium/WhatsApp Web). El plan Free limita a 50 MB por objeto (el código avisa a partir de 45 MB). |
| Postgres `whatsapp_sessions` | Fila índice: `clientId` (PK, `tenantId_branchId` saneado), `storagePath`, `dataHash` (sha256 para omitir subidas idénticas), `phoneNumber`. |
| Disco local (`WA_SESSION_DIR`, default `./.wa-sessions`) | Directorio de trabajo efímero de RemoteAuth. |

Historia: el zip vivía en una columna `data` de Postgres. Agotaba el Disk IO
budget de Supabase por reescribir ~30 MB en cada backup.
[`scripts/migrate-wa-session-to-storage.ts`](../scripts/migrate-wa-session-to-storage.ts)
fue el puente de un solo uso: subió los blobs a Storage y adelantó las columnas
índice, **antes** de que la migración `20260806150000` borrara `data`. Hoy es
idempotente e inofensivo (sin filas con `data` no hace nada), pero la columna ya
no existe, así que sobre una base actual fallaría en el `SELECT "data"`. Es un
artefacto histórico: se puede retirar en la fase 8.

Observaciones:

- **Quien tiene el zip es dueño de la sesión.** No está cifrado más allá del
  bucket privado; quien tenga la service-role key puede abrir WhatsApp como ese
  número. Es inherente a web.js.
- **Local y producción comparten el Storage.** `.env.local` solo sobreescribe
  `DATABASE_URL`/`DIRECT_URL`, así que el desarrollo local usa el **mismo
  Supabase Storage de producción**. Además, la réplica local copia
  `whatsapp_sessions` desde prod. El propio código lo advierte: emparejar la
  sesión de plataforma desde local pisaría el zip de producción. Hoy lo evita
  `WA_RESTORE_ON_BOOT=false` en dev, pero no hay ninguna barrera técnica.

## 7. Qué ocurre durante deploy/restart

Secuencia en Railway (deploy con solapamiento):

1. Arranca el contenedor nuevo. `onApplicationBootstrap` **no espera**: el
   healthcheck responde y la restauración corre en segundo plano.
2. El contenedor nuevo espera `WA_RESTORE_DELAY_MS` (25 s) y luego, por cada
   sesión guardada (hasta `WA_MAX_ACTIVE_SESSIONS`), descarga el zip (~30 MB)
   desde Storage y levanta un Chromium.
3. El contenedor viejo recibe SIGTERM → `onModuleDestroy` → backup final (máx.
   15 s) → `destroy()`.

| Pregunta | Respuesta | Evidencia |
|---|---|---|
| ¿Puede invalidar sesiones? | **Sí, en casos límite.** Si el contenedor viejo no alcanzó a subir su último backup y el nuevo restaura un perfil desactualizado, WhatsApp puede rechazarlo y exigir un QR nuevo. Si llega `LOGOUT/UNPAIRED`, se purga todo. | `backupNow` con timeout de 15 s; RemoteAuth sube cada 30 min. |
| ¿Puede crear clientes duplicados? | **En un mismo proceso no:** `pair()` es idempotente por clave mientras la sesión esté viva. **Entre procesos sí:** durante el solapamiento, dos contenedores pueden tener abierta la misma sesión. | `sessions` es un `Map` en memoria por proceso; no hay lock distribuido. |
| ¿Puede inicializar varias sesiones? | Sí, si el delay de 25 s no basta para que muera el viejo. **Ambos** clientes tienen `takeoverOnConflict: true`, así que pueden quitarse la sesión uno al otro en bucle (*ping-pong*) hasta que el viejo muera. | `takeoverOnConflict` en `pair()`. |
| ¿Puede generar nuevos QR? | Sí: si el zip no existe, está corrupto o fue rechazado, `initialize()` emite `qr`. En un boot nadie lo escanea, así que la sesión queda en `qr_ready` ocupando un cupo y un Chromium hasta que alguien haga `disconnect`. | `pair()` no distingue restaurar de emparejar desde cero. |
| ¿Puede provocar reconexiones? | **Sí, por diseño:** cada deploy o reinicio es un login nuevo de WhatsApp Web desde un Chromium nuevo, y con `restartPolicy ON_FAILURE` (×10), un crash en bucle (OOM de Chromium, por ejemplo) produce hasta 10 logins seguidos. | `railway.json`, ~400 MB por Chromium. |
| ¿Puede generar listeners duplicados? | **No dentro de un proceso.** Los listeners se registran por instancia de `Client`, y los clientes destruidos salen del `Map`. `@OnEvent` se registra una vez por provider singleton. | Revisado `pair()`/`destroyClient()`. |
| ¿Puede repetir mensajes? | **Plausible, no demostrado.** web.js puede emitir `message_create` para mensajes recibidos mientras el proceso estaba caído; el agente respondería mensajes viejos. No hay deduplicación por id de mensaje. Del lado saliente, un reintento manual repite el envío (no hay idempotencia). | No se persiste `message.id`. |
| ¿Puede perder autenticación? | Sí: zip corrupto o desactualizado, `LOGOUT` desde el celular, o fallos de subida a Storage (se registran y se ignoran). | `StorageRemoteAuthStore.save` traga errores (a propósito). |

## 8. Riesgos encontrados y severidad

> Ninguno de estos hallazgos demuestra la causa del "Account in review". Son
> comportamientos que **pueden contribuir** al riesgo de restricción o a
> incidentes. Las severidades miden impacto × probabilidad en el estado actual.

### CRÍTICO

**R1. `/whatsapp/*` no tiene autenticación y acepta cualquier tenant por header.**
[whatsapp.controller.ts](../src/whatsapp/whatsapp.controller.ts) no tiene
`@UseGuards` y no hay `APP_GUARD` global. `resolveCtx` toma `X-Tenant-Id`, el
query o el body, y cae en `tenant-barber-001` si no hay nada. Consecuencias
concretas:

- `POST /whatsapp/test` con `X-Tenant-Id: __platform__` y
  `X-Branch-Id: __platform__` envía **texto libre arbitrario a cualquier número
  desde el WhatsApp de Lynko**. Lo mismo con la sesión de cualquier tenant.
- `GET /whatsapp/session/status|stream` expone el QR de emparejamiento de
  cualquier sesión.
- `DELETE /whatsapp/session` hace logout y purga el respaldo de cualquier sesión,
  incluida la de Lynko.
- `GET /whatsapp/session/diagnostics` expone rutas, versión y memoria.

Es una superficie de spam (envíos masivos involuntarios o maliciosos) y de
sabotaje. **No hay evidencia en el código de que se haya usado**, pero no hay
logs de envío del tenant con los que descartarlo.

**Complicación:** la reserva pública (`BookingConfirmation.tsx`) llama
`notify-customer` y `notify-business` **desde el navegador del cliente final, sin
login**. Poner un guard JWT sin más rompe la confirmación de reservas públicas.
El arreglo correcto es que el backend envíe la confirmación al crear la cita
(server-side). Ver "PR 0" al final.

**R2. Texto libre editable + destinatario libre = cualquier contenido sale con la
identidad del negocio.** `notify-*` recibe del cliente `customerPhone`,
`customerName`, `serviceName` y `businessName` sin verificar que exista una cita
real. Combinado con R1, cualquiera puede mandar a cualquier número un mensaje con
la plantilla del negocio y datos inventados.

### ALTO

**R3. Ping-pong de sesión durante el deploy (`takeoverOnConflict` en ambos
contenedores).** Varias tomas de sesión seguidas desde distintos Chromium e IPs
es el patrón de "sesión inestable" que más rápido llama la atención de los
sistemas anti-automatización. Es una hipótesis razonable, no una certeza.

**R4. Un login nuevo de WhatsApp Web en cada deploy, más crash loops de hasta
×10.** Cada reinicio es una "nueva conexión de dispositivo vinculado".
Desplegar con frecuencia multiplica reconexiones. Ningún componente limita
cuántas reconexiones se permiten por hora.

**R5. Kill switch inexistente en la práctica.** `PlatformMessagingSettings.waEnabled`
no se consulta al enviar. No hay switch por tenant. El único interruptor real es
`agentEnabled`, y solo afecta las respuestas del agente.

**R6. Cero idempotencia y cero registro en envíos de tenant.** Doble clic,
reintentos del usuario, re-render de React (`BookingConfirmation` usa un `useRef`
que no sobrevive a un remount) o un refresh de la página de confirmación se
convierten en mensajes duplicados al cliente final. No hay tabla donde detectarlo
ni auditarlo.

**R7. El desarrollo local comparte Storage con producción.** Un `pair` de la
sesión de plataforma desde local, o un `WA_RESTORE_ON_BOOT=true` puesto por
error, abre el número real de Lynko desde un segundo equipo. Eso es exactamente
R3, pero sin deploy de por medio.

**R8. Dependencia de una versión de WhatsApp Web fijada a mano que caduca.**
`WA_WEB_VERSION` caduca (~11-nov-2026 según el comentario) y se sirve desde un
repositorio de terceros (`wppconnect-team/wa-version` en GitHub). Cuando
caduque: fallos de `initialize`, reintentos manuales y más logins.

### MEDIO

**R9. El restore ordena después de limitar.** `findMany({ orderBy: updatedAt,
take: maxActiveSessions })` y luego `sort` por plataforma. Si la sesión de Lynko
no está entre las N más recientes, **no se restaura**, pese a lo que dice el
comentario.

**R10. Un QR huérfano tras el boot ocupa un cupo.** Si un restore cae a
`qr_ready`, queda un Chromium vivo indefinidamente (el timeout de pairing solo
cubre `initializing`). Con `WA_MAX_ACTIVE_SESSIONS=1` (valor de `.env.example`)
bloquea cualquier otro emparejamiento.

**R11. No hay reconexión ni alertas ante `disconnected` no terminal.** La sesión
queda caída en silencio hasta el próximo deploy. Los envíos fallan con 503 y
nadie se entera. Esto reduce el spam, pero produce pérdida silenciosa de avisos.

**R12. Posible respuesta a mensajes viejos tras un restart** (ver §7). Plausible,
no verificado en logs.

**R13. Inferencia de identidad por texto en el takeover.** `consumeOwnSend`
compara el cuerpo exacto dentro de 30 s. Si el agente envía dos textos iguales,
o el eco tarda más de 30 s, el agente se silencia solo (falso positivo, poco
dañino).

**R14. `getNumberId` en cada envío.** Es una consulta extra a WhatsApp por
mensaje. Cuando el número no existe, el envío falla, pero la consulta ya se hizo.
Cloud API no la necesita.

### BAJO

**R15.** `whatsappReminders` (plan) y `NotificationPreference.whatsapp` existen
pero no se usan. No es un riesgo hoy; sí lo sería si alguien los "enciende"
creyendo que funcionan.

**R16.** `scripts/migrate-wa-session-to-storage.ts` está obsoleto (la columna
`data` ya no existe). Es inofensivo si nadie lo corre; si alguien lo corre,
falla en el `SELECT`.

**R17.** El país está fijado en `57` en dos sitios distintos
(`whatsapp-webjs.provider.ts` y `phone.util.ts`). Hay que unificarlo antes de
usar Cloud API, que exige E.164.

**R18.** `orders/notify-*` es código sin llamadores en el frontend: superficie
expuesta (R1) sin uso.

## 9. Dependencias directas de whatsapp-web.js

| Archivo | Símbolos | ¿Fuera de `src/whatsapp`? |
|---|---|---|
| `src/whatsapp/whatsapp-session.manager.ts` | `Client`, `Message`, `RemoteAuth` | no |
| `src/whatsapp/providers/whatsapp-webjs.provider.ts` | `Client` (vía `getClient()`): `getNumberId`, `sendMessage` | no |
| `src/whatsapp/storage-remote-auth.store.ts` | contrato de `RemoteAuth` (sin import) | no |
| `src/platform-messaging/channels/whatsapp.channel.ts` | **`MessageMedia`**; `Client` vía `getClient()`: `getNumberId`, `sendMessage` (texto, media + caption) | **sí** |
| `src/assistant/channels/whatsapp-inbound.service.ts` | `Client` vía `getClient()`: `getChatById`, `sendSeen`, `sendStateTyping`, `clearState`, `sendMessage` | **sí** |
| `src/platform-messaging/platform-messaging.controller.ts` | `WhatsAppSessionManager.pair/disconnect` (concepto QR) | **sí** (indirecto) |
| `Dockerfile` | Chromium y librerías gráficas | infra |

Los módulos de negocio (barber, retail, restaurant, finance…) **no** importan
WhatsApp. Su acoplamiento está en el **frontend**, que decide cuándo notificar.

## 10. Qué podemos reutilizar

- **`IMessagingProvider` / `MESSAGING_PROVIDER`.** Es el punto de inyección
  correcto para los envíos del tenant. Solo hay que ampliar el contrato.
- **`IPlatformChannelSender`.** Cloud API entra como otra implementación para el
  número de Lynko.
- **`MessageSenderService`** completo: preview, bloqueadores, tolerancia por
  canal e historial en `PlatformMessage`. Ya tiene `dedupeKey @unique`.
- **`WhatsAppService` y `WhatsappTemplatesService`.** Sirven como capa de casos
  de uso. El render de texto libre seguirá sirviendo para el proveedor legacy y
  para mensajes dentro de la ventana de 24 h.
- **`LynkoAgentService` y `ConversationService`.** Son agnósticos del transporte:
  el agente recibe `(channel, externalUserId, message)`.
- **`WhatsAppInboundService`.** Su lógica de filtrado, debounce, tope y
  telemetría se conserva. Solo cambia de dónde vienen los eventos y por dónde
  salen las respuestas.
- **El evento `wa.message` (`WhatsAppMessageEvent`).** El webhook de Meta puede
  emitir exactamente este mismo evento, y el agente no se entera del cambio.
- **`rawBody: true`** en `main.ts`, necesario para validar la firma
  `X-Hub-Signature-256`.
- **Patrón de secretos de `PlatformMessagingSettings.resendApiKey`**: nunca se
  devuelve; solo `hasApiKey` y los últimos 4 caracteres. Se reutiliza el mismo
  criterio para los tokens de Meta, añadiendo cifrado.
- **Bucket privado de Supabase**, si hiciera falta guardar media.

## 11. Qué debemos desacoplar

1. **`WhatsAppPlatformChannel` → `getClient()` + `MessageMedia`.** Debe hablar
   con un puerto de transporte, no con web.js.
2. **`WhatsAppInboundService.send()` → `getClient()`.** El "escribiendo…", el
   visto y el envío deben ir por el puerto, con operaciones opcionales (Cloud API
   tiene marcar-como-leído e indicador de escritura 🔎; si un proveedor no los
   tiene, son no-op).
3. **Gestión de conexión ≠ envío.** `WhatsAppSessionManager` mezcla el ciclo de
   vida de web.js con el estado de la conexión que consume la UI. Cloud API no
   tiene QR ni Chromium: la UI debe consumir un **estado de conexión** neutro
   (`connected/disconnected/pending/restricted`), no `qr_ready`.
4. **La decisión de *cuándo* notificar debe pasar del frontend al backend.** Hoy
   el navegador decide y manda los datos del mensaje. Con Cloud API (con costo
   por mensaje, plantillas y calidad del número en juego) el backend debe
   disparar los avisos a partir de hechos de dominio (cita creada, pedido
   listo…), con idempotencia.
5. **El render de texto libre del tenant ≠ el mensaje que inicia el negocio.**
   Para Cloud API, el caso de uso debe producir `{ templateKey, variables }`, y
   el proveedor decide si eso se traduce a texto (legacy) o a plantilla aprobada
   (Meta).

## 12. Arquitectura objetivo (adaptada al proyecto real)

No hace falta crear un `MessagingModule` nuevo desde cero. Se reorganiza lo que
existe:

```
src/whatsapp/                          (sigue siendo el módulo de WhatsApp)
  connections/
    whatsapp-connection.service.ts     ← NUEVO: resuelve "qué conexión usa este envío"
                                          (Lynko | tenant/branch) y su proveedor
  transport/
    whatsapp-transport.interface.ts    ← NUEVO puerto: sendText, sendTemplate, sendMedia,
                                          markRead?, typing?, status()
    webjs.transport.ts                 ← adapta WhatsAppSessionManager (legacy)
    meta-cloud.transport.ts            ← NUEVO: Graph API
  outbox/
    whatsapp-outbox.service.ts         ← NUEVO: idempotencia, rate limit, kill switch,
                                          opt-out, reintentos, auditoría
    whatsapp-outbox.worker.ts          ← NUEVO: despacha la cola
  webhooks/
    meta-webhook.controller.ts         ← NUEVO: verify + POST firmado
    meta-webhook.service.ts            ← estados → outbox; mensajes → evento 'wa.message'
  whatsapp-session.manager.ts          (legacy, intacto hasta la fase 8)
  whatsapp.service.ts                  (casos de uso del tenant: ahora encolan en outbox)
  providers/whatsapp-webjs.provider.ts (se convierte en/delega a webjs.transport)

src/platform-messaging/channels/whatsapp.channel.ts
  → usa WhatsAppConnectionService.forPlatform() + outbox (ya no getClient)

src/assistant/channels/whatsapp-inbound.service.ts
  → sigue escuchando 'wa.message'; responde por el transporte de la conexión de plataforma
```

Flujo de envío objetivo:

```
Dominio (cita creada, pedido listo)  ─┐
Backoffice (cobro Lynko)             ─┼─► caso de uso (WhatsAppService / MessageSenderService)
Agente (respuesta)                   ─┘        │  { connectionRef, to, templateKey, vars, idempotencyKey }
                                               ▼
                                  WhatsAppOutboxService.enqueue()
                                   · kill switch global / conexión / tenant
                                   · opt-out del destinatario
                                   · dedupe por idempotencyKey (UNIQUE)
                                   · rate limit por conexión
                                               ▼
                                     whatsapp_messages (QUEUED)
                                               ▼
                                  Worker → transport(connection.provider)
                                   · WEBJS      → WhatsAppSessionManager
                                   · META_CLOUD → POST /{phone_number_id}/messages
                                               ▼
                         SENT (+wamid) ── webhook ──► DELIVERED / READ / FAILED
```

Regla de oro: **el proveedor es una propiedad de la conexión, no del entorno.**
Así, Lynko puede estar en Cloud API mientras un tenant sigue en web.js, y se
revierte conexión por conexión.

## 13. Modelo multitenant propuesto

- **Una conexión = un número de WhatsApp**: `WhatsAppConnection`.
  - `ownerType = PLATFORM` → el número de Lynko. Hay exactamente una conexión
    activa de este tipo.
  - `ownerType = TENANT` → el número del negocio. Por defecto, alcance **tenant**
    (`branchId = null`). Opcionalmente, por sede, si el negocio tiene un número
    por sede. Hoy las sesiones son por sede; se mantiene compatible.
- **Resolución de la conexión de un envío de tenant:** primero la de la sede;
  si no hay, la del tenant; si no hay, **no se envía** (`skipped:
  no_connection`). **Nunca se cae a la conexión de Lynko.** Esta regla se
  impone en un único lugar (`WhatsAppConnectionService`) y se cubre con un test.
- **Enrutamiento del webhook:** `phone_number_id` → conexión → tenant. Es la
  única fuente de verdad. Nada del payload decide el tenant por sí mismo.
- **`phoneNumberId` es único en todo el sistema**, de modo que un número no
  puede quedar conectado a dos tenants.
- **Credenciales:**
  - Lynko: token de *system user* propio, con permisos sobre su WABA.
  - Tenant con Embedded Signup: token de *business integration* por cliente 🔎,
    cifrado en la base.
- **Aislamiento:** toda consulta de mensajes, plantillas, opt-outs y métricas
  filtra por `connectionId`, y la conexión por `tenantId`. Los endpoints de
  tenant salen del JWT (`TenantGuard`), nunca de headers sin verificar.

## 14. WhatsApp Lynko vs WhatsApp Tenant

| | WhatsApp de Lynko | WhatsApp del tenant |
|---|---|---|
| Destinatario | Dueños y usuarios de tenants | Clientes finales del negocio |
| Contenido | Cobros, mora, reportes, alertas, soporte, agente | Confirmaciones, recordatorios, cancelaciones, pedido listo, factura |
| Quién lo configura | Lynko (super-admin), una vez | El dueño, desde Configuración → WhatsApp |
| WABA | La de Lynko | La del negocio (es su activo; si se va de Lynko, se lleva su número) |
| Token | System user de Lynko (env/secret) | Por conexión, cifrado en la base |
| Plantillas | Las crea y aprueba Lynko en su WABA | Deben existir en la WABA **del tenant**; Lynko las crea por API al conectar 🔎 |
| Entrante | Lo atiende el agente de Lynko | No lo atiende el agente de Lynko. Fase inicial: solo estados; respuestas de clientes = futuro (bandeja o reenvío) |
| Facturación Meta | Lynko | El negocio (método de pago en su WABA) 🔎 |
| Fallback si cae | Correo (ya existe) | **Ninguno al número de Lynko.** Se marca `skipped` y se avisa al dueño |

## 15. Estrategia Cloud API

**Envío** 🔎: `POST https://graph.facebook.com/{version}/{phone-number-id}/messages`
con `Authorization: Bearer <token>`.

- `type: "template"`: `name`, `language.code`, `components[].parameters[]`. Es lo
  que se usa para todo mensaje que inicia el negocio.
- `type: "text"`: **solo** dentro de la ventana de atención al cliente (24 h desde
  el último mensaje **del usuario**). Aplica al agente de Lynko y a cualquier
  respuesta conversacional.
- `type: "image" | "document"` con `link` o `id` de media: para el QR de pago y
  el PDF. Fuera de la ventana van como header de una plantilla con media.

**Ventana de 24 h.** El outbox registra el `lastInboundAt` por
(conexión, contacto) a partir del webhook. Si un envío pide texto libre fuera de
la ventana, el outbox lo **rechaza** (`skipped: outside_window`) en lugar de
intentarlo. Meta lo rechazaría igual, con error.

**Mapeo de los casos actuales:**

| Caso actual | Cloud API |
|---|---|
| `APPOINTMENT_CUSTOMER` (confirmación al cliente) | Plantilla UTILITY `appointment_confirmation` |
| `APPOINTMENT_BUSINESS` (aviso al negocio) | Plantilla UTILITY. Revisar si tiene sentido: es el negocio escribiéndose a sí mismo (desde su número a su número personal). Puede reemplazarse por notificación push o in-app |
| `ORDER_CUSTOMER` / `ORDER_BUSINESS` | Plantillas UTILITY `order_confirmation` / `order_ready` |
| Medios de pago (texto armado por el cajero) | Plantilla UTILITY `payment_instructions` con header de imagen (QR) y variables. El texto libre del cajero solo puede salir si el cliente escribió en las últimas 24 h |
| Cobro / mora de Lynko (`payment_reminder` / `payment_overdue`) | Plantillas UTILITY en la WABA de Lynko 🔎 (si Meta las clasifica como MARKETING, el costo cambia) |
| Respuestas del agente | Texto libre (siempre dentro de la ventana: responde a un mensaje entrante) |
| `/whatsapp/test` | Plantilla `hello_world` (número de prueba) o plantilla de prueba propia |

**Lo que se pierde con Cloud API** y requiere decisión de producto:

- **El texto 100 % libre del dueño en los avisos.** Opciones:
  1. Plantillas fijas de Lynko, con variables, que el dueño solo enciende y
     apaga.
  2. Un set de variantes pre-aprobadas por vertical.
  3. "Texto adicional" como variable acotada (Meta limita las variables
     abiertas; 🔎 políticas).
- **El takeover humano por eco.** Si el número del tenant pasa a Cloud API, el
  dueño ya no puede escribir desde la app del celular, **salvo** con el modo
  *coexistence* (WhatsApp Business App + Cloud API), que entrega los ecos por
  webhook 🔎. Para Lynko importa: si un humano atiende desde el celular, hay que
  activar coexistence o usar una bandeja en la consola.
- **Saber si el número "está registrado en WhatsApp" antes de enviar**
  (`getNumberId`). En Cloud API se envía y se recibe `failed` con un código de
  error. Eso es mejor: es una consulta menos.

**Calidad y límites** 🔎: cada número tiene un *quality rating*
(GREEN/YELLOW/RED) y un *messaging limit tier* (conversaciones o destinatarios
únicos iniciados por el negocio en 24 h). Se reciben por webhook
(`phone_number_quality_update`, `account_update`) y se guardan en la conexión.
El outbox **frena** los envíos de una conexión en RED o cerca de su tope.

**Versión de Graph:** configurable (`META_GRAPH_API_VERSION`), sin dejarla fija
en el código.

## 16. Webhooks

Endpoint único para la app de Meta (Meta configura **un** callback por app 🔎):

- `GET /api/v1/webhooks/meta/whatsapp`: verificación. Si `hub.mode=subscribe` y
  `hub.verify_token === META_WEBHOOK_VERIFY_TOKEN`, responde `hub.challenge`
  como texto.
- `POST /api/v1/webhooks/meta/whatsapp`:
  1. Valida `X-Hub-Signature-256` = `sha256=HMAC_SHA256(META_APP_SECRET,
     rawBody)` con comparación en tiempo constante. Si no coincide → 401, y no
     se procesa nada.
  2. Guarda el payload crudo (`WhatsAppWebhookEvent`) y responde **200 de
     inmediato**. Meta reintenta si tarda o falla 🔎, así que el procesamiento es
     asíncrono.
  3. Procesa:
     - `entry[].changes[].value.metadata.phone_number_id` → conexión. Si no
       existe, se registra como huérfano y no se procesa.
     - `statuses[]`: `sent | delivered | read | failed` → actualiza
       `WhatsAppMessage` por `wamid`. **Los estados pueden llegar fuera de
       orden**: se aplica una máquina de estados monotónica (no se baja de
       `read` a `delivered`). `failed` guarda `errors[].code/title`.
     - `messages[]` → dedupe por `wamid` (los webhooks pueden repetirse 🔎) →
       actualiza `lastInboundAt` → detecta STOP/BAJA para opt-out → si la
       conexión es la de Lynko, emite `wa.message` (el mismo evento que hoy) y
       el agente no cambia.
     - Ecos de coexistence (si se habilita) → `wa.message` con `fromMe: true`,
       lo que preserva el takeover humano.
     - Campos de cuenta: `message_template_status_update`,
       `phone_number_quality_update`, `account_update` → actualizan plantilla o
       conexión, y pueden **pausar automáticamente** la conexión.
- Sin guards JWT (lo llama Meta). La protección es la firma, y además se le
  aplica un rate limit propio.

## 17. Templates

Hay dos sistemas de plantillas hoy, y ninguno se elimina:

- `PlatformMessageTemplate`: textos de Lynko editables desde la consola.
- `WhatsappTemplate`: textos del tenant.

Lo que se añade:

- **Catálogo de plantillas Meta**, definido en código como fuente de verdad (lo
  que Lynko propone), igual que hoy `message-templates.ts`:
  `{ key, metaName, category, language, components, variables: ['cliente','fecha',…] }`.
  Las variables con nombre del código se mapean a `{{1}}…{{n}}`.
- **`WhatsAppTemplateBinding`** por conexión: estado de esa plantilla en **esa**
  WABA (`PENDING / APPROVED / REJECTED / PAUSED / DISABLED`), su `metaTemplateId`
  y el motivo de rechazo. Se sincroniza:
  - al conectar (Lynko crea las plantillas en la WABA del tenant vía
    `POST /{waba-id}/message_templates` 🔎);
  - por webhook `message_template_status_update`;
  - con un refresco manual.
- **Regla del outbox:** solo se envía una plantilla si su binding está
  `APPROVED`. En cualquier otro caso: `skipped: template_not_approved`, sin
  reintentos.
- **Versionado:** cambiar el texto de una plantilla aprobada implica crear
  `appointment_confirmation_v2` y migrar el binding. No se edita en caliente.
- `WhatsappTemplate.enabled` (apagar un aviso) se conserva y sigue mandando
  sobre todo lo demás.

## 18. Seguridad, idempotencia y rate limits

| Mecanismo | Diseño |
|---|---|
| **Autenticación** | Todo endpoint de tenant con `JwtAuthGuard + TenantGuard + PermissionsGuard`; el tenant sale del JWT. Las páginas públicas no envían WhatsApp: el backend lo hace al crear la reserva pública. El webhook solo se autentica con firma HMAC. |
| **Idempotencia** | `idempotencyKey` **obligatoria** y `UNIQUE (connectionId, idempotencyKey)` en `whatsapp_messages`. Se construye desde el hecho de dominio, no desde la petición: `appt:{appointmentId}:confirmation`, `appt:{id}:reminder:24h`, `order:{id}:ready`, `platform:{tenantId}:payment_reminder:{periodo}`. Si el scheduler corre 4 veces, el `INSERT` choca 3 veces y se devuelve el registro existente: el cliente lo recibe **una vez**. Reprogramar una cita genera una clave nueva (`…:confirmation:{startTime}`). |
| **Deduplicación entrante** | `wamid` único en mensajes entrantes y en eventos de estado. Webhook crudo con hash para descartar reentregas. |
| **Queue** | Outbox en Postgres (no hay Redis en el proyecto). El worker toma lotes con `SELECT … FOR UPDATE SKIP LOCKED`, que funciona incluso con más de una instancia. Primera versión: `setInterval` en proceso con lock. `@nestjs/schedule` o BullMQ quedan como mejora posterior (cambian `package.json`). |
| **Retry con backoff** | Solo errores **transitorios** (5xx, timeouts, rate limit de Meta 🔎): 1 min → 5 min → 30 min, `maxAttempts = 3`, con jitter. Errores **permanentes** (número inválido, plantilla no aprobada, fuera de ventana, opt-out, parámetros inválidos): `FAILED` sin reintento. Nunca hay reintentos infinitos. |
| **Expiración** | Cada mensaje tiene `expiresAt` (p. ej. un recordatorio de una cita que ya pasó). El worker descarta lo vencido (`CANCELLED: expired`). |
| **Rate limit por conexión/tenant** | Token bucket en la base o en memoria con techo conservador (p. ej. 20/min y N/día por conexión de tenant, configurable). Tope adicional de destinatarios únicos por día, por debajo del *tier* de Meta. Al superarlo, se encola con retraso; no se descarta en silencio. |
| **Circuit breaker** | Si más del X % de los últimos N envíos de una conexión fallan, o llega un webhook de calidad RED o de cuenta restringida, la conexión pasa a `PAUSED` automáticamente y se avisa al dueño y a Lynko. |
| **Kill switch** | Tres niveles, consultados por el outbox **antes de cada envío** (no al encolar): 1) global (`WHATSAPP_SENDING_ENABLED` + `PlatformMessagingSettings.waEnabled`, que hoy existe y no se usa); 2) por conexión (`sendingEnabled`); 3) por tenant y propósito (`WhatsappTemplate.enabled`). Apagar no borra la cola: deja los mensajes `HELD`. |
| **Opt-in / opt-out** | Opt-in implícito por relación transaccional (reservó o compró y dejó su número), registrado con la fuente. Opt-out: palabras clave entrantes (STOP, BAJA, NO MÁS) y botón de plantilla 🔎 → `WhatsAppOptOut (connectionId, phone)`. El outbox lo respeta en todo lo que no sea estrictamente transaccional y solicitado. |
| **Logs y auditoría** | `whatsapp_messages` guarda quién originó el envío (usuario, sistema o agente), propósito, plantilla, variables y estados con timestamps. Los logs de aplicación enmascaran teléfonos (`…4567`), como ya hace el agente. |
| **Calidad / conexión** | `qualityRating`, `messagingLimitTier`, `status` y `lastHealthCheckAt` en la conexión, visibles en Configuración → WhatsApp y en la consola de plataforma. |
| **Separación entre tenants** | Toda resolución de conexión es por `tenantId` del JWT o por `phone_number_id` del webhook. No hay fallback cruzado. Hay un test que garantiza que un tenant sin conexión **no** envía por la de Lynko. |
| **Secretos** | Tokens cifrados con AES-256-GCM (`WHATSAPP_CREDENTIALS_KEY`, 32 bytes, rotable con `keyId`). Nunca se devuelven por la API ni se escriben en logs. |

## 19. Plan de migración por fases

Cada fase se puede desplegar por separado. Ninguna toca whatsapp-web.js salvo la
8.

### Fase 0: auditoría (este documento)
- Entregable: este documento revisado y aprobado.
- **Recomendación urgente, independiente de Cloud API:** PR 0 de seguridad (ver
  el final).

### Fase 1: abstraer el transporte (sin cambios de comportamiento)
- Introducir el puerto `WhatsAppTransport` con su implementación web.js, que
  delega en `WhatsAppSessionManager`.
- `WhatsAppPlatformChannel` y `WhatsAppInboundService.send()` dejan de usar
  `getClient()` y `MessageMedia`, y pasan a usar el puerto.
- Unificar `normalizePhone` (R17) en un único util que produzca E.164.
- Arreglar R9 (ordenar antes de limitar el restore). Es un cambio de
  comportamiento menor y deseable; puede ir aparte.
- Criterio de salida: `grep "from 'whatsapp-web.js'"` solo encuentra archivos
  dentro de `src/whatsapp/`.

### Fase 2: outbox + `MetaCloudTransport` (desactivado)
- Migración Prisma (aditiva): `WhatsAppConnection`, `WhatsAppMessage`,
  `WhatsAppWebhookEvent`, `WhatsAppOptOut`, `WhatsAppTemplateBinding`.
- `WhatsAppOutboxService` + worker. Los envíos actuales (web.js) **también**
  pasan por el outbox: así ganan idempotencia, auditoría, kill switch y rate
  limit desde el primer día.
- `MetaCloudTransport` y el webhook, detrás de `WHATSAPP_META_ENABLED=false`.
- Hacer efectivo `waEnabled` como kill switch global.

### Fase 3: POC con el número de prueba de Meta
- App de Meta en modo desarrollo, número de prueba, destinatarios en la
  allow-list 🔎.
- Probar en staging o local (nunca contra la base de producción):
  - plantilla `hello_world`;
  - plantilla propia de cita;
  - texto dentro de la ventana;
  - webhook de estados `sent → delivered → read`;
  - `failed` con un número inválido;
  - un mensaje entrante que llega al agente vía `wa.message`.
- Verificar la firma con un payload alterado (debe dar 401).

### Fase 4: WhatsApp de Lynko en Cloud API
- Número de Lynko en su propia WABA, verificación de negocio, *display name*
  aprobado y system user token 🔎.
- **Decisión:** usar un número nuevo, o migrar el actual (el número en "Account
  in review"). Migrar un número que está en revisión puede bloquearse; conviene
  resolver primero su estado con Meta o empezar con un número limpio.
- Plantillas de Lynko aprobadas: cobro, mora y alertas.
- Crear la conexión `PLATFORM` con `provider = META_CLOUD`. La de web.js queda
  `DISABLED` pero no se borra (rollback).
- Si se requiere atención humana desde el celular, activar coexistence 🔎 o
  aceptar que el takeover se hace desde la consola.

### Fase 5: tenant piloto
- Un tenant de confianza, conectado **manualmente** (Lynko carga
  `wabaId`/`phoneNumberId`/token desde la consola de plataforma; todavía sin
  Embedded Signup).
- Solo la confirmación de cita.
- Kill switch y rate limit con valores bajos. Monitoreo diario de
  `whatsapp_messages` y de la calidad del número.

### Fase 6: automatizaciones transaccionales del tenant
- Mover el disparo al backend:
  - reserva pública creada → confirmación;
  - cita cancelada o reprogramada;
  - recordatorio a 24 h (primer scheduler real: corre sobre el outbox con
    `idempotencyKey = appt:{id}:reminder:24h`);
  - pedido listo;
  - factura.
- El frontend deja de llamar `notify-*`. Esos endpoints quedan solo para envíos
  manuales autenticados (botón "reenviar", que usa la misma `idempotencyKey`
  salvo que se pida explícitamente un reenvío).
- Usar `whatsappReminders` del plan para el gating por plan (R15).

### Fase 7: onboarding oficial (Embedded Signup)
- Requisitos previos 🔎: Lynko como Tech Provider o Solution Partner, app
  verificada, App Review de `whatsapp_business_management` y
  `whatsapp_business_messaging`, verificación del negocio Lynko.
- UI: Configuración → WhatsApp → **[Conectar WhatsApp]** → popup de Meta
  (Facebook Login for Business con `config_id`). El frontend recibe un `code` y
  el `waba_id`/`phone_number_id` por `sessionInfo`.
- Backend:
  1. intercambia el `code` por el token;
  2. suscribe la app a la WABA (`POST /{waba-id}/subscribed_apps`);
  3. registra el número si hace falta (`POST /{phone-number-id}/register`);
  4. crea las plantillas;
  5. guarda la conexión cifrada.
- El cliente nunca ve WABA ID, tokens ni webhooks.
- Desconectar desde Lynko: desuscribir la app, marcar la conexión `DISCONNECTED`
  y borrar el token.

### Fase 8: deprecar whatsapp-web.js
- Cuando ninguna conexión activa use `WEBJS` durante N semanas:
  - quitar `WhatsAppSessionManager`, `StorageRemoteAuthStore`, `webjs.transport`
    y los endpoints `/whatsapp/session/*`;
  - quitar Chromium del `Dockerfile` (imagen mucho más liviana y ~400 MB menos
    de RAM por sesión);
  - quitar las variables `WA_*` y `PUPPETEER_*`;
  - borrar los zips de Storage y retirar `scripts/migrate-wa-session-to-storage.ts`;
  - desinstalar `whatsapp-web.js` y `qrcode` (si nada más lo usa; hay un módulo
    `src/qr`, hay que verificarlo).
- La tabla `whatsapp_sessions` se elimina en una migración posterior, no en la
  misma.

## 20. Plan de pruebas

| Nivel | Qué |
|---|---|
| Unit | `WhatsAppConnectionService`: un tenant sin conexión **no** obtiene la de Lynko; prioridad sede → tenant. Outbox: idempotencia (4 `enqueue` con la misma clave → 1 fila, 1 envío); kill switch en sus 3 niveles; opt-out; ventana de 24 h; clasificación de errores permanente/transitorio; backoff y máximo de intentos; expiración. Firma del webhook (válida, alterada, ausente). Máquina de estados de `statuses` fuera de orden. Mapeo de variables con nombre a `{{n}}`. |
| Integración (DB réplica local) | Worker con `SKIP LOCKED` y dos workers concurrentes (cada mensaje sale una sola vez). Webhook duplicado (un solo efecto). |
| Contrato | `MetaCloudTransport` contra un mock HTTP con payloads reales de la documentación de Meta (envío OK, error 131026, 131047 fuera de ventana, rate limit 🔎 códigos). |
| E2E (fase 3) | Número de prueba de Meta: plantilla, texto en ventana, estados, inbound → agente. |
| Regresión legacy | Tras la fase 1 y la fase 2, con web.js: emparejar, enviar una confirmación de cita, recibir un mensaje en el número de plataforma con el agente encendido, y desconectar. Debe comportarse igual que antes. |
| Seguridad | Los endpoints `/whatsapp/*` sin JWT devuelven 401 (tras el PR 0). Un JWT de tenant A no puede operar la conexión de tenant B ni la de Lynko. |
| Operación | Simular un deploy con la conexión `PLATFORM` en Cloud API: no hay QR ni Chromium, no hay reconexión y ningún mensaje se pierde (el outbox retoma lo `SENDING` vencido). |

## 21. Rollback por fase

| Fase | Rollback | WhatsApp queda usable porque… |
|---|---|---|
| 1 | Revert del PR (sin migración). | El transporte web.js hace exactamente lo mismo que el código anterior. |
| 2 | `WHATSAPP_OUTBOX_ENABLED=false` → los casos de uso llaman al transporte directo, como hoy. Las tablas nuevas quedan sin usar (la migración es aditiva; no hace falta revertirla). | web.js sigue intacto. |
| 3 | No toca producción (app en modo desarrollo). | No aplica. |
| 4 | Cambiar la conexión `PLATFORM` a `provider = WEBJS` y reactivarla. Requiere que la sesión web.js de Lynko siga emparejada o se pueda emparejar con un número que no sea el de Cloud API: **un mismo número no puede estar en Cloud API y en WhatsApp Web a la vez** 🔎. Por eso conviene que el número de Cloud API sea distinto del actual durante la transición. El correo sigue siendo el fallback de cobros. | El canal de correo existe y el número legacy no se tocó. |
| 5 | `sendingEnabled=false` en la conexión del piloto, o volver su `provider` a `WEBJS`. | El resto de tenants nunca salió de web.js. |
| 6 | Flag por evento (`WHATSAPP_AUTO_APPOINTMENT_CONFIRMATION=false`, etc.) → se vuelve a permitir el disparo manual. El código del frontend que llama `notify-*` se quita en un PR separado y posterior. | Los envíos manuales siguen funcionando. |
| 7 | Ocultar el botón (feature flag). Las conexiones ya creadas siguen funcionando: son filas normales. | La carga manual (fase 5) sigue disponible. |
| 8 | Solo se ejecuta tras N semanas sin uso de web.js. Rollback = revertir el PR y reinstalar la dependencia. La sesión vieja ya no existe, así que habría que re-emparejar: por eso esta fase va al final y sin prisa. | No aplica. |

## 22. Variables de entorno nuevas

| Variable | Uso |
|---|---|
| `WHATSAPP_META_ENABLED` | Enciende el transporte y el webhook de Meta (default `false`). |
| `WHATSAPP_OUTBOX_ENABLED` | Enruta los envíos por el outbox (default `false` hasta validar). |
| `WHATSAPP_SENDING_ENABLED` | Kill switch global de emergencia (default `true`). Complementa `waEnabled` de la base. |
| `META_APP_ID` | App de Meta. |
| `META_APP_SECRET` | Firma del webhook e intercambio de `code` (secreto). |
| `META_GRAPH_API_VERSION` | p. ej. `v2X.0` 🔎. |
| `META_WEBHOOK_VERIFY_TOKEN` | Handshake GET del webhook (secreto). |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | Fase 7. |
| `META_SYSTEM_USER_TOKEN` | Token de Lynko (alternativa: guardarlo cifrado en la conexión `PLATFORM`; se recomienda la base para poder rotarlo sin redeploy, como ya se hace con Resend y Wompi). |
| `WHATSAPP_CREDENTIALS_KEY` | Clave AES-256-GCM (32 bytes base64) para cifrar tokens en la base. |
| `WHATSAPP_RATE_PER_MINUTE` / `WHATSAPP_RATE_PER_DAY` | Topes por defecto por conexión. |
| `WHATSAPP_MAX_ATTEMPTS` | Default `3`. |
| `WHATSAPP_DEFAULT_COUNTRY_CODE` | Reemplaza el `57` fijado en el código (R17). |

## 23. Cambios Prisma potenciales (fase 2; todos aditivos)

```prisma
enum WhatsAppProvider      { WEBJS META_CLOUD }
enum WhatsAppOwnerType     { PLATFORM TENANT }
enum WhatsAppConnStatus    { PENDING CONNECTED PAUSED RESTRICTED DISCONNECTED DISABLED }
enum WhatsAppMsgStatus     { QUEUED HELD SENDING SENT DELIVERED READ FAILED SKIPPED CANCELLED }
enum WhatsAppDirection     { OUTBOUND INBOUND }

model WhatsAppConnection {
  id                 String   @id @default(cuid())
  ownerType          WhatsAppOwnerType
  tenantId           String?            // null solo si PLATFORM
  branchId           String?            // null = todo el tenant
  provider           WhatsAppProvider
  status             WhatsAppConnStatus @default(PENDING)
  sendingEnabled     Boolean  @default(true)   // kill switch por conexión
  pausedReason       String?
  displayPhone       String?
  // Meta
  businessId         String?
  wabaId             String?
  phoneNumberId      String?  @unique
  accessTokenEnc     String?            // AES-GCM, nunca sale por API
  tokenKeyId         String?
  tokenExpiresAt     DateTime?
  qualityRating      String?
  messagingLimitTier String?
  // web.js (legacy)
  webjsClientId      String?  @unique   // = whatsapp_sessions.clientId
  ratePerMinute      Int?
  ratePerDay         Int?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
  @@index([tenantId, branchId])
}

model WhatsAppMessage {
  id               String   @id @default(cuid())
  connectionId     String
  tenantId         String?
  direction        WhatsAppDirection
  to               String              // E.164
  purpose          String              // 'appointment_confirmation', 'platform_payment_reminder', 'agent_reply'…
  templateKey      String?
  templateLanguage String?
  variables        Json?
  body             String?             // snapshot del texto
  idempotencyKey   String?
  status           WhatsAppMsgStatus @default(QUEUED)
  providerMessageId String? @unique    // wamid
  attempts         Int      @default(0)
  nextAttemptAt    DateTime?
  expiresAt        DateTime?
  errorCode        String?
  lastError        String?
  origin           String              // 'user:<id>' | 'system' | 'agent' | 'public_booking'
  sentAt           DateTime?
  deliveredAt      DateTime?
  readAt           DateTime?
  failedAt         DateTime?
  createdAt        DateTime @default(now())
  @@unique([connectionId, idempotencyKey])
  @@index([status, nextAttemptAt])
  @@index([tenantId, createdAt])
}

model WhatsAppWebhookEvent { id, receivedAt, payloadHash @unique, payload Json, processedAt?, error? }
model WhatsAppOptOut       { connectionId, phone, source, createdAt  @@id([connectionId, phone]) }
model WhatsAppContactWindow{ connectionId, phone, lastInboundAt      @@id([connectionId, phone]) }
model WhatsAppTemplateBinding { connectionId, key, metaName, language, category, status, metaTemplateId?, rejectedReason?, updatedAt  @@unique([connectionId, key, language]) }
```

- Hay que llevar las sesiones existentes de `whatsapp_sessions` a
  `WhatsAppConnection(provider=WEBJS)` con un *backfill* idempotente.
  `whatsapp_sessions` sigue existiendo: es del legacy.
- `PlatformMessage` se queda como historial de la consola. Con el tiempo puede
  apuntar a `WhatsAppMessage.id`; no hace falta fusionarlas.
- Las migraciones se prueban primero contra la réplica local (`prisma migrate
  dev`) y a producción solo van con `migrate deploy`, según el flujo del
  repositorio.

## 24. Archivos que habría que crear o modificar

**Crear**
- `src/whatsapp/transport/whatsapp-transport.interface.ts`
- `src/whatsapp/transport/webjs.transport.ts`
- `src/whatsapp/transport/meta-cloud.transport.ts` (+ `meta-graph.client.ts`)
- `src/whatsapp/connections/whatsapp-connection.service.ts`
- `src/whatsapp/outbox/whatsapp-outbox.service.ts`, `whatsapp-outbox.worker.ts`, `rate-limiter.ts`
- `src/whatsapp/webhooks/meta-webhook.controller.ts`, `meta-webhook.service.ts`, `meta-signature.util.ts`
- `src/whatsapp/templates/meta-templates.catalog.ts`
- `src/common/crypto/secret-box.ts` (AES-GCM)
- `src/whatsapp/phone.ts` (E.164 unificado) o mover `platform-messaging/phone.util.ts` a `common`
- Specs de cada uno
- `prisma/migrations/<fecha>_whatsapp_cloud_foundation/`
- Frontend (fase 7): pantalla Configuración → WhatsApp con Embedded Signup

**Modificar**
- `src/whatsapp/whatsapp.module.ts`: registrar transportes, outbox y webhook.
- `src/whatsapp/providers/*`: el puerto actual se amplía o pasa a ser el transporte.
- `src/whatsapp/whatsapp.service.ts`: encolar con `idempotencyKey` en lugar de enviar directo.
- `src/whatsapp/whatsapp.controller.ts`: guards (PR 0) y ocultar `/session/*` cuando la conexión es Meta.
- `src/platform-messaging/channels/whatsapp.channel.ts`: usar el transporte o el outbox.
- `src/platform-messaging/services/message-sender.service.ts`: `dedupeKey`, `waEnabled`.
- `src/assistant/channels/whatsapp-inbound.service.ts`: responder por el transporte.
- Backend de reservas públicas y citas (barber) y de pedidos (retail): disparar avisos (fase 6).
- `src/whatsapp/whatsapp-session.manager.ts`: solo R9 y R10 (fase 1).
- Frontend: `BookingConfirmation.tsx` y `NewAppointmentModal.tsx` dejan de notificar (fase 6); `use-whatsapp-session.ts` pasa a consumir el estado neutro.
- `.env.example`, `Dockerfile` (fase 8), `railway.json` (sin cambios previstos).

## 25. Qué NO debemos tocar inicialmente

- **`whatsapp-web.js`, `package.json` y `Dockerfile` (Chromium).** Siguen hasta
  la fase 8.
- **`WhatsAppSessionManager` y `StorageRemoteAuthStore`.** Salvo R9 y R10, están
  afinados contra incidentes reales: el `delete()` no-op, el backup al apagar,
  el retraso del restore y `takeoverOnConflict`. Cambiarlos sin necesidad
  arriesga la sesión de producción.
- **La tabla `whatsapp_sessions` y los zips en Storage.** Ni siquiera hay que
  renombrarlos.
- **El número que está en "Account in review".** No hay que reconectarlo,
  re-emparejarlo, cambiarlo de proveedor ni usarlo en pruebas mientras su estado
  no esté resuelto con Meta.
- **`LynkoAgentService` y `ConversationService`.** Son agnósticos del transporte.
- **`PlatformMessageTemplate` y el editor de plantillas de la consola.**
- **El flujo de correo (`EmailPlatformChannel`).** Es el fallback de cobros
  durante toda la migración.
- **Pruebas de Cloud API contra la base de producción o desde local con el
  Storage de producción** (R7).

---

## Próximo cambio recomendado

### PR 0 (prioritario, de seguridad; **sí cambia el comportamiento**, requiere tu decisión)

No es parte de la migración, pero es el riesgo más alto encontrado (R1). Tiene
dos variantes:

- **0-a, mínima:** poner `JwtAuthGuard + PasswordSetGuard + TenantGuard` en
  `/whatsapp/session/*`, `/whatsapp/test` y `/whatsapp/payment-methods`. Ningún
  flujo público los usa. Los `notify-*` se quedan abiertos de momento, por la
  reserva pública, pero **solo** para tenants reales (sin fallback a DEMO y
  rechazando `__platform__`).
- **0-b, completa:** además, la confirmación de la reserva pública la dispara el
  backend al crear la cita pública, y `notify-*` pasa a requerir JWT.

Recomiendo **0-a ya**. Cierra el envío arbitrario desde el número de Lynko y el
logout remoto sin romper ninguna pantalla (hay que confirmar que el frontend
autenticado ya manda el JWT a esos endpoints). 0-b encaja en la fase 6.

### PR 1: el más pequeño de la migración, **sin cambio de comportamiento**

**"Puerto de transporte de WhatsApp: sacar el `Client` de web.js de platform-messaging y del agente".**

- Crear `src/whatsapp/transport/whatsapp-transport.interface.ts` con:
  - `sendText(conn, to, body)`;
  - `sendMedia(conn, to, { url, filename, caption? })`;
  - `markRead?(conn, chatId)`;
  - `typing?(conn, chatId, on)`;
  - `status(conn)`.

  `conn` es por ahora `{ tenantId, branchId }`.
- Crear `src/whatsapp/transport/webjs.transport.ts`. Mueve **tal cual** la lógica
  que hoy vive en:
  - `WhatsAppWebJsProvider.sendText` (`getNumberId` + `sendMessage`);
  - `WhatsAppPlatformChannel.send/fetchMedia` (imagen con caption, documentos,
    la lógica de `bodyDelivered`);
  - `WhatsAppInboundService.send` (`sendSeen`, typing, `clearState`).
- `WhatsAppPlatformChannel` y `WhatsAppInboundService` inyectan el transporte en
  lugar de `WhatsAppSessionManager.getClient()`.
- Specs con el transporte mockeado, que verifican que los dos consumidores
  llaman lo mismo que antes, en el mismo orden (incluida la pausa de tecleo y la
  re-verificación de `pending` del agente).
- Sin migraciones, sin variables nuevas y sin tocar `package.json`, el session
  manager, los endpoints ni el frontend.
- Criterio de aceptación: `grep -rn "from 'whatsapp-web.js'" src` solo devuelve
  archivos de `src/whatsapp/`. Regresión manual en local (con una sesión de
  prueba, **no** la de plataforma de producción): enviar una confirmación,
  enviar un cobro con QR, y que el agente responda un mensaje.
- Rollback: revertir el PR.

Este PR prepara el sitio exacto donde se conectará `MetaCloudTransport` en la
fase 2, y no cambia nada de lo que ocurre en producción.

> No se implementa ningún PR ni commit hasta que apruebes este documento.
