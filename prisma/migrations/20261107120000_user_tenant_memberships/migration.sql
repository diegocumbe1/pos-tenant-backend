-- Una persona, varios negocios: accesos adicionales para el switch "Cambiar de negocio".
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo crea una tabla nueva; no toca ninguna existente ni hace backfill.
--   · El negocio principal sigue en users."tenantId"/"roleId". Quien tiene un solo
--     negocio no tiene filas aquí y su acceso no cambia.
--   · Idempotente: IF NOT EXISTS y constraints dentro de DO $$.

CREATE TABLE IF NOT EXISTS "user_tenant_memberships" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "grantedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_tenant_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_tenant_memberships_userId_tenantId_key"
  ON "user_tenant_memberships"("userId", "tenantId");
CREATE INDEX IF NOT EXISTS "user_tenant_memberships_tenantId_idx"
  ON "user_tenant_memberships"("tenantId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_tenant_memberships_userId_fkey') THEN
    ALTER TABLE "user_tenant_memberships" ADD CONSTRAINT "user_tenant_memberships_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_tenant_memberships_tenantId_fkey') THEN
    ALTER TABLE "user_tenant_memberships" ADD CONSTRAINT "user_tenant_memberships_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_tenant_memberships_roleId_fkey') THEN
    ALTER TABLE "user_tenant_memberships" ADD CONSTRAINT "user_tenant_memberships_roleId_fkey"
      FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
