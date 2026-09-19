CREATE TABLE "alexa_skills" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tenantId" TEXT,
    "actingUserId" TEXT NOT NULL,
    "activationHash" TEXT,
    "ttlDays" INTEGER NOT NULL DEFAULT 7,
    "alexaUserId" TEXT,
    "alexaDeviceId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "alexa_skills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "alexa_skills_applicationId_key" ON "alexa_skills"("applicationId");
CREATE INDEX "alexa_skills_tenantId_idx" ON "alexa_skills"("tenantId");

ALTER TABLE "alexa_skills" ADD CONSTRAINT "alexa_skills_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "alexa_skills" ADD CONSTRAINT "alexa_skills_actingUserId_fkey"
  FOREIGN KEY ("actingUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Solo el rol de backend accede a las skills de voz.
ALTER TABLE "alexa_skills" ENABLE ROW LEVEL SECURITY;
