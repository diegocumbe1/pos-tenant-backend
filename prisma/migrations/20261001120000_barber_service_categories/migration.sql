-- Categorías de servicios como lista gestionada (antes: texto libre por servicio).
-- El servicio sigue guardando el nombre en barber_services.category.

CREATE TABLE "barber_service_categories" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "branchId"  TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "barber_service_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "barber_service_categories_branchId_name_key" ON "barber_service_categories"("branchId", "name");
CREATE INDEX "barber_service_categories_tenantId_idx" ON "barber_service_categories"("tenantId");

ALTER TABLE "barber_service_categories" ADD CONSTRAINT "barber_service_categories_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "barber_service_categories" ADD CONSTRAINT "barber_service_categories_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- El texto libre traía espacios sueltos; así cada servicio coincide con su fila.
UPDATE "barber_services" SET "category" = NULLIF(TRIM("category"), '') WHERE "category" IS NOT NULL;

-- Siembra: las categorías que los servicios ya usan, para que nadie arranque
-- con la lista vacía. Orden alfabético inicial.
INSERT INTO "barber_service_categories" ("id", "tenantId", "branchId", "name", "sortOrder", "updatedAt")
SELECT
  gen_random_uuid()::text,
  c."tenantId",
  c."branchId",
  c."name",
  (ROW_NUMBER() OVER (PARTITION BY c."branchId" ORDER BY c."name") - 1)::int,
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT "tenantId", "branchId", TRIM("category") AS "name"
  FROM "barber_services"
  WHERE "category" IS NOT NULL AND TRIM("category") <> ''
) c;
