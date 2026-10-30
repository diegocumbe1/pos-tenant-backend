-- Eliminar para siempre horarios de clases ARCHIVADOS.
--
-- SEGURA: solo agrega una columna NULL y un permiso.
--   · `deletedAt` en barber_class_schedules: el horario desaparece de toda la
--     pantalla de Clases. Las asistencias y pagos de quienes fueron no se tocan.
--   · Permiso `barber:classes:delete`, solo para el rol OWNER. A otros roles se
--     les da desde Roles y permisos.
-- Idempotente: IF NOT EXISTS y ON CONFLICT.
ALTER TABLE "barber_class_schedules" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

INSERT INTO "permissions" ("id", "code", "resource", "action", "description")
VALUES (
  gen_random_uuid()::text,
  'barber:classes:delete',
  'barber-classes',
  'delete',
  'Eliminar para siempre horarios de clases archivados'
)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE p."code" = 'barber:classes:delete'
  AND r."code" = 'OWNER'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
