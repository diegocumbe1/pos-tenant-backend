-- Tenant-controlled vocabulary for the public booking renderer.  Keeping this
-- as JSON makes it safe to add new labels without a schema migration per word.
ALTER TABLE "barber_settings"
ADD COLUMN "publicBookingCopy" JSONB NOT NULL DEFAULT '{}';
