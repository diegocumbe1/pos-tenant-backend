-- AlterTable
ALTER TABLE "barber_public_sites"
    ADD COLUMN "publishedByUserId" TEXT,
    ADD COLUMN "draftPayload" JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN "publishedPayload" JSONB;

-- Helpful index for published public lookups where a snapshot exists.
CREATE INDEX "barber_public_sites_slug_published_snapshot_idx"
ON "barber_public_sites"("slug")
WHERE "status" = 'published' AND "publishedPayload" IS NOT NULL;
