-- Permiso nuevo: cancelar un envío no entregado / eliminar producto de la orden.
-- Idempotente: seguro de correr sobre tenants existentes sin re-seed.

-- 1) Alta del permiso global (code es UNIQUE → ON CONFLICT no duplica).
INSERT INTO "permissions" ("id", "code", "resource", "action", "description")
VALUES (
  gen_random_uuid()::text,
  'restaurant:orders:cancel-item',
  'orders',
  'cancel-item',
  'Cancelar envío no entregado / eliminar producto de la orden'
)
ON CONFLICT ("code") DO NOTHING;

-- 2) Asignarlo por DEFAULT solo al rol OWNER (admin) de cada tenant.
--    Los demás roles lo reciben desde Ajustes → Roles y permisos.
--    PK compuesta (roleId, permissionId) → ON CONFLICT no duplica.
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE p."code" = 'restaurant:orders:cancel-item'
  AND r."code" = 'OWNER'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
