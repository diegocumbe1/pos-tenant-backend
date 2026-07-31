-- CreateTable
CREATE TABLE "whatsapp_sessions" (
    "clientId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "data" BYTEA,
    "phoneNumber" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_sessions_pkey" PRIMARY KEY ("clientId")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_sessions_tenantId_branchId_key" ON "whatsapp_sessions"("tenantId", "branchId");
