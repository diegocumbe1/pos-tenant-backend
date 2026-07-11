-- CreateTable
CREATE TABLE "billing_contacts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "phone" TEXT NOT NULL,
    "whatsapp" TEXT,
    "email" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_contacts_tenantId_idx" ON "billing_contacts"("tenantId");

-- AddForeignKey
ALTER TABLE "billing_contacts" ADD CONSTRAINT "billing_contacts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
