-- Backfill barber permissions for existing barber tenants created before
-- the barber module introduced granular `barber:*` permissions.
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "roles" r
JOIN "tenants" t ON t.id = r."tenantId"
JOIN "business_verticals" v ON v.id = t."verticalId"
JOIN "permissions" p ON p.code LIKE 'barber:%'
WHERE v.code = 'barber'
  AND r.code IN ('OWNER', 'MANAGER')
ON CONFLICT DO NOTHING;
