-- Vínculo sede ↔ Play Mundial (token de servicio para consultar las reservas de canchas).
--
-- SEGURA PARA PRODUCCIÓN:
--   · Solo CREA una tabla nueva: no toca ninguna existente.
--   · Idempotente: IF NOT EXISTS en tabla e índices.
--   · Sin datos: nadie tiene vínculo hasta que el dueño lo crea en Ajustes.

CREATE TABLE IF NOT EXISTS "playmundial_links" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "playmundial_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "playmundial_links_branchId_key" ON "playmundial_links"("branchId");
CREATE UNIQUE INDEX IF NOT EXISTS "playmundial_links_tokenHash_key" ON "playmundial_links"("tokenHash");
CREATE INDEX IF NOT EXISTS "playmundial_links_tenantId_idx" ON "playmundial_links"("tenantId");
