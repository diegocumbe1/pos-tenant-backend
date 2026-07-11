-- Optional legal/tax identifier shown on customer receipts.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "documentId" TEXT;
