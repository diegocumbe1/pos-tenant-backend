ALTER TABLE "menu_public_configs" ADD COLUMN IF NOT EXISTS "branchId" TEXT;

CREATE INDEX IF NOT EXISTS "menu_public_configs_branchId_idx" ON "menu_public_configs"("branchId");

UPDATE "menu_public_configs" cfg
SET "branchId" = (
  SELECT b."id"
  FROM "branches" b
  WHERE b."tenantId" = cfg."tenantId"
  ORDER BY b."createdAt" ASC
  LIMIT 1
)
WHERE cfg."branchId" IS NULL;

INSERT INTO "menu_public_configs" (
    "id",
    "tenantId",
    "branchId",
    "slug",
    "isPublished",
    "showPrices",
    "showDescription",
    "showImages",
    "showUnavailable",
    "showFeaturedBadge",
    "showRatings",
    "showSavedCount",
    "featuredProductIds",
    "categoryOrder",
    "templateId",
    "primaryColor",
    "accentColor",
    "heroTitle",
    "heroDescription",
    "featuredTitle",
    "featuredDescription",
    "updatedAt"
)
SELECT
    'menu-config-' || right(md5(t."id"), 16),
    t."id",
    (
      SELECT b."id"
      FROM "branches" b
      WHERE b."tenantId" = t."id"
      ORDER BY b."createdAt" ASC
      LIMIT 1
    ),
    lower(regexp_replace(regexp_replace(t."name", '[^a-zA-Z0-9]+', '-', 'g'), '(^-|-$)', '', 'g')) || '-' || right(t."id", 6),
    false,
    true,
    true,
    true,
    false,
    true,
    false,
    false,
    ARRAY[]::TEXT[],
    ARRAY[]::TEXT[],
    'cards',
    '#16a34a',
    '#f97316',
    t."name",
    'Explora nuestra carta',
    'Destacados',
    'Los favoritos de la casa',
    CURRENT_TIMESTAMP
FROM "tenants" t
ON CONFLICT ("tenantId") DO NOTHING;
