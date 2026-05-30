-- AlterTable
ALTER TABLE "barber_public_sites"
    ADD COLUMN "publishedSlug" TEXT;

-- Existing rows need an explicit publish action to create a publishedPayload.
-- Keep the current slug as the published lookup only when a snapshot exists.
UPDATE "barber_public_sites"
SET "publishedSlug" = "slug"
WHERE "publishedPayload" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "barber_public_sites_publishedSlug_key"
ON "barber_public_sites"("publishedSlug")
WHERE "publishedSlug" IS NOT NULL;

CREATE INDEX "barber_public_sites_publishedSlug_status_idx"
ON "barber_public_sites"("publishedSlug", "status")
WHERE "publishedSlug" IS NOT NULL;
