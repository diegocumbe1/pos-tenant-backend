# Módulo `platform/` — Backoffice super-admin (cross-tenant)

Implementa el backoffice de plataforma (P0). Cross-tenant: **NO** usa `X-Tenant-Id`.
Ver `docs/BACKOFFICE_ARCHITECTURE.md` §3 y §10.

## Seguridad

- Todos los endpoints: `@UseGuards(JwtAuthGuard, PlatformAdminGuard)`.
- `PlatformAdminGuard` exige `req.user.isPlatformAdmin === true`. El **ROOT** queda
  marcado como platform admin (`isPlatformAdmin = user.isPlatformAdmin || roleCode === 'ROOT'`).
- Sin el claim → `403 { code: 'NOT_PLATFORM_ADMIN' }`.
- Toda mutación escribe `PlatformAuditLog` (actor, `before`→`after`, timestamp).

## Identidad de plataforma

- Superadmins: `admin@uselynko.com`, `noreply@uselynko.com` (crear con
  `npm run bootstrap:root -- --email admin@uselynko.com --name "Admin" --password "..."`).
  `bootstrap-root.ts` ya setea `isPlatformAdmin = true`.
- El seed marca el flag de forma idempotente si esos emails ya existen localmente.

## Reglas de shape (el FE `ApiAdminRepository` mapea 1:1)

- Enums en **MAYÚSCULA** (`TenantStatus`, `SubscriptionStatus`, plan). `billingCycle` en **minúscula**.
- Timestamps **ISO string**; montos **enteros** (COP/USD).
- `listTenants` incluye `status`, `subscription` y `usersCount`/`branchesCount`.
- `subscription/{activate|suspend|cancel}` refleja en `tenant.status` (`ACTIVE`/`SUSPENDED`/`INACTIVE`).
- `PATCH /platform/users/:id/status` con `{ status: 'ACTIVE'|'DISABLED' }` → `User.isActive`.

## Endpoints (`/api/v1/platform/*`)

| Método | Ruta                                          | Body                                                                | Devuelve                                                  |
| ------ | --------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| GET    | `/platform/tenants`                           | —                                                                   | `{ tenants: Tenant[] }` (status+subscription+counts)      |
| GET    | `/platform/tenants/:id`                       | —                                                                   | `Tenant` + `features` efectivos                           |
| PATCH  | `/platform/tenants/:id/plan`                  | `{ plan }`                                                          | `Tenant`                                                  |
| PATCH  | `/platform/tenants/:id/features`              | `{ feature, value }` (`value=null` quita override)                  | `Tenant`                                                  |
| DELETE | `/platform/tenants/:id/features`              | —                                                                   | `Tenant`                                                  |
| GET    | `/platform/tenants/:id/usage`                 | —                                                                   | `{ users, branches, terminals, aiChatThisMonth, limits }` |
| PATCH  | `/platform/tenants/:id/status`                | `{ status }`                                                        | `Tenant`                                                  |
| GET    | `/platform/tenants/:id/users`                 | —                                                                   | `{ users: TenantUser[] }`                                 |
| GET    | `/platform/tenants/:id/subscription`          | —                                                                   | `Subscription \| null`                                    |
| PATCH  | `/platform/tenants/:id/subscription`          | `{ plan?, billingCycle?, currentPeriodEnd?, priceCOP?, priceUSD? }` | `Subscription`                                            |
| POST   | `/platform/tenants/:id/subscription/activate` | `{}`                                                                | `Subscription` (→ tenant ACTIVE)                          |
| POST   | `/platform/tenants/:id/subscription/suspend`  | `{ reason? }`                                                       | `Subscription` (→ tenant SUSPENDED)                       |
| POST   | `/platform/tenants/:id/subscription/cancel`   | `{ reason? }`                                                       | `Subscription` (→ tenant INACTIVE)                        |
| PATCH  | `/platform/users/:id/status`                  | `{ status: 'ACTIVE'\|'DISABLED' }`                                  | `TenantUser`                                              |

## Finanzas internas del backoffice

Estas rutas son de **Lynko como plataforma**, no de los negocios/tenants. Usan pagos de suscripción
como ingresos y modelos propios (`PlatformExpense`, `PlatformFinanceGoal`) para gastos y metas.

| Método | Ruta                                       | Body                                                          | Devuelve                                                             |
| ------ | ------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/platform/finance/dashboard?period=month` | —                                                             | ingresos, gastos, utilidad, MRR, tenants activos y progreso de metas |
| GET    | `/platform/finance/expenses?period=month`  | —                                                             | `{ expenses: PlatformExpense[] }`                                    |
| POST   | `/platform/finance/expenses`               | `{ category, concept, amount, currency?, incurredAt, note? }` | `PlatformExpense`                                                    |
| PATCH  | `/platform/finance/expenses/:id`           | campos parciales                                              | `PlatformExpense`                                                    |
| DELETE | `/platform/finance/expenses/:id`           | —                                                             | `{ ok, id }`                                                         |
| GET    | `/platform/finance/goals?month=YYYY-MM`    | —                                                             | `{ periodMonth, goals: PlatformFinanceGoal[] }`                      |
| POST   | `/platform/finance/goals`                  | `{ periodMonth, metric, target }`                             | crea/actualiza una meta                                              |
| PATCH  | `/platform/finance/goals/:id`              | `{ target }`                                                  | `PlatformFinanceGoal`                                                |
| DELETE | `/platform/finance/goals/:id`              | —                                                             | `{ ok, id }`                                                         |

Métricas soportadas para metas: `revenue_cop`, `profit_cop`, `mrr_cop`,
`payments_count`, `active_tenants`.

## Enforcement de acceso por suscripción (login)

En `auth.service` (login, accept-invite y `GET /auth/me`), para usuarios que **no** son
platform admin ni ROOT:

- `user.isActive === false` → `403 { code: 'USER_DISABLED' }`.
- `tenant.status !== 'ACTIVE'` **o** `subscription.status ∉ {TRIALING, ACTIVE, PAST_DUE}`
  → `403 { code: 'ACCOUNT_INACTIVE', tenantStatus, subscriptionStatus }`.

Suspender/cancelar la suscripción (o desactivar el tenant) desde el backoffice **corta el login**.

## Catálogo de features

`src/platform/plans/plan-features.ts` **espeja exactamente** `PLAN_FEATURES` del FE
(`pos-system/core/config/plans.config.ts`). `GET /auth/me` devuelve `features` efectivos
(`PLAN_FEATURES[plan]` + `featureOverrides`). El **gating server-side** (`@RequireFeature` +
`PlanFeatureGuard` + límites) es P1 (PR separado).

## Migración / seed

```bash
npx prisma migrate deploy        # aplica migraciones platform/backoffice/finance
npm run db:seed                  # subscriptions por tenant + flag superadmins (si existen)
npm run bootstrap:root -- --email admin@uselynko.com --name "Admin" --password "..."
```
