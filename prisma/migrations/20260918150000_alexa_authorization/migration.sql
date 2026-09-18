CREATE TABLE "alexa_authorizations" (
    "id" TEXT NOT NULL,
    "configDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "alexa_authorizations_pkey" PRIMARY KEY ("id")
);
-- Only the backend database role may access voice authorizations.
ALTER TABLE "alexa_authorizations" ENABLE ROW LEVEL SECURITY;
