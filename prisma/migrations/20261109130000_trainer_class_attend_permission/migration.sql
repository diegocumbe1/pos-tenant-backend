-- Permiso del rol Entrenador (gimnasios): pasar lista en sus clases.
--
-- El código ya lo crea solo la primera vez que el dueño le da acceso a un
-- entrenador (BarberStaffService.ensureTrainerRole). Esta migración lo deja en el
-- catálogo desde el despliegue, para que exista por defecto en todos los
-- ambientes sin depender de ese primer acceso ni del seed.
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo INSERTA: no borra ni reescribe permisos de ningún rol.
--   · Idempotente: no duplica el permiso (code es único) ni la asignación.
--   · NO usa prisma/seed.ts, que crea negocios de demo y reescribe permisos.

INSERT INTO "permissions" ("id", "code", "resource", "action", "description")
SELECT 'perm_barber_classes_attend', 'barber:classes:attend', 'barber-classes', 'attend',
       'Pasar lista en sus clases (rol Entrenador)'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "code" = 'barber:classes:attend');

-- Roles Entrenador que existan sin el permiso (por si alguno se creó antes).
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" = 'barber:classes:attend'
WHERE r."code" = 'TRAINER'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."roleId" = r."id" AND rp."permissionId" = p."id"
  );
