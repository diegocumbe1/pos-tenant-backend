-- CreateTable
CREATE TABLE "barber_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "phone" TEXT,
    "city" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Bogota',
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "logoUrl" TEXT,
    "bookingSlug" TEXT NOT NULL,
    "onlineBookingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
    "loyaltyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "themeTemplateId" TEXT NOT NULL DEFAULT 'studio',
    "themePrimaryColor" TEXT NOT NULL DEFAULT '#6366f1',
    "themeAccentColor" TEXT NOT NULL DEFAULT '#22c55e',
    "themeLogoMode" TEXT DEFAULT 'initials',
    "themeLogoImageUrl" TEXT,
    "themeBannerImageUrl" TEXT,
    "heroTitle" TEXT,
    "heroDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "barber_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "barber_services" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "durationMin" INTEGER NOT NULL,
    "priceCOP" INTEGER NOT NULL,
    "color" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "barber_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "barber_staff" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "avatarUrl" TEXT,
    "color" TEXT,
    "bio" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "barber_staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "barber_staff_services" (
    "staffId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barber_staff_services_pkey" PRIMARY KEY ("staffId","serviceId")
);

-- CreateTable
CREATE TABLE "barber_customers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "totalVisits" INTEGER NOT NULL DEFAULT 0,
    "lastVisitAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "barber_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "barber_appointments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "scheduledEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "notes" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "barber_appointments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "barber_settings_branchId_key" ON "barber_settings"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "barber_settings_bookingSlug_key" ON "barber_settings"("bookingSlug");

-- CreateIndex
CREATE INDEX "barber_settings_tenantId_idx" ON "barber_settings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "barber_services_branchId_name_key" ON "barber_services"("branchId", "name");

-- CreateIndex
CREATE INDEX "barber_services_tenantId_idx" ON "barber_services"("tenantId");

-- CreateIndex
CREATE INDEX "barber_services_branchId_isActive_idx" ON "barber_services"("branchId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "barber_staff_branchId_name_key" ON "barber_staff"("branchId", "name");

-- CreateIndex
CREATE INDEX "barber_staff_tenantId_idx" ON "barber_staff"("tenantId");

-- CreateIndex
CREATE INDEX "barber_staff_branchId_isActive_idx" ON "barber_staff"("branchId", "isActive");

-- CreateIndex
CREATE INDEX "barber_staff_services_serviceId_idx" ON "barber_staff_services"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "barber_customers_branchId_phone_key" ON "barber_customers"("branchId", "phone");

-- CreateIndex
CREATE INDEX "barber_customers_tenantId_idx" ON "barber_customers"("tenantId");

-- CreateIndex
CREATE INDEX "barber_customers_branchId_name_idx" ON "barber_customers"("branchId", "name");

-- CreateIndex
CREATE INDEX "barber_appointments_tenantId_idx" ON "barber_appointments"("tenantId");

-- CreateIndex
CREATE INDEX "barber_appointments_branchId_status_idx" ON "barber_appointments"("branchId", "status");

-- CreateIndex
CREATE INDEX "barber_appointments_staffId_scheduledAt_idx" ON "barber_appointments"("staffId", "scheduledAt");

-- CreateIndex
CREATE INDEX "barber_appointments_customerId_scheduledAt_idx" ON "barber_appointments"("customerId", "scheduledAt");

-- AddForeignKey
ALTER TABLE "barber_settings" ADD CONSTRAINT "barber_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_settings" ADD CONSTRAINT "barber_settings_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_services" ADD CONSTRAINT "barber_services_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_services" ADD CONSTRAINT "barber_services_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_staff" ADD CONSTRAINT "barber_staff_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_staff" ADD CONSTRAINT "barber_staff_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_staff_services" ADD CONSTRAINT "barber_staff_services_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "barber_staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_staff_services" ADD CONSTRAINT "barber_staff_services_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "barber_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_customers" ADD CONSTRAINT "barber_customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_customers" ADD CONSTRAINT "barber_customers_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_appointments" ADD CONSTRAINT "barber_appointments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_appointments" ADD CONSTRAINT "barber_appointments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_appointments" ADD CONSTRAINT "barber_appointments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "barber_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_appointments" ADD CONSTRAINT "barber_appointments_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "barber_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barber_appointments" ADD CONSTRAINT "barber_appointments_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "barber_staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
