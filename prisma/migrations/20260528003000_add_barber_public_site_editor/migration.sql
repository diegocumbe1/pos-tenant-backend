-- CreateTable
CREATE TABLE "barber_public_sites" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMP(3),
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "ogImageUrl" TEXT,
    "themePrimary" TEXT NOT NULL DEFAULT '#6366f1',
    "themeAccent" TEXT NOT NULL DEFAULT '#22c55e',
    "themeInk" TEXT NOT NULL DEFAULT '#0f172a',
    "themeBackground" TEXT NOT NULL DEFAULT '#ffffff',
    "themeSurface" TEXT NOT NULL DEFAULT '#f8fafc',
    "themeRadius" TEXT NOT NULL DEFAULT 'md',
    "shortName" TEXT,
    "neighborhood" TEXT,
    "city" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barber_public_sites_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "barber_public_sites_status_check" CHECK ("status" IN ('draft', 'published')),
    CONSTRAINT "barber_public_sites_themeRadius_check" CHECK ("themeRadius" IN ('sm', 'md', 'lg'))
);

-- CreateTable
CREATE TABLE "barber_public_site_sections" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "width" TEXT NOT NULL DEFAULT 'contained',
    "density" TEXT NOT NULL DEFAULT 'comfortable',
    "title" TEXT,
    "eyebrow" TEXT,
    "subtitle" TEXT,
    "body" TEXT,
    "ctaLabel" TEXT,
    "ctaAction" TEXT,
    "ctaHref" TEXT,
    "assetIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barber_public_site_sections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "barber_public_site_sections_type_check" CHECK ("type" IN ('hero', 'trust_bar', 'services', 'gallery', 'instagram', 'booking_cta', 'booking_modal', 'contact')),
    CONSTRAINT "barber_public_site_sections_width_check" CHECK ("width" IN ('contained', 'wide', 'full')),
    CONSTRAINT "barber_public_site_sections_density_check" CHECK ("density" IN ('compact', 'comfortable', 'immersive')),
    CONSTRAINT "barber_public_site_sections_ctaAction_check" CHECK ("ctaAction" IS NULL OR "ctaAction" IN ('open_booking', 'scroll_services', 'open_whatsapp', 'external_link'))
);

-- CreateTable
CREATE TABLE "barber_public_site_assets" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "path" TEXT,
    "bucket" TEXT,
    "alt" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "fit" TEXT NOT NULL DEFAULT 'cover',
    "focalPoint" TEXT NOT NULL DEFAULT 'center',
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barber_public_site_assets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "barber_public_site_assets_kind_check" CHECK ("kind" IN ('logo', 'hero', 'gallery', 'background', 'thumbnail')),
    CONSTRAINT "barber_public_site_assets_fit_check" CHECK ("fit" IN ('cover', 'contain')),
    CONSTRAINT "barber_public_site_assets_focalPoint_check" CHECK ("focalPoint" IN ('center', 'top', 'bottom', 'left', 'right'))
);

-- CreateTable
CREATE TABLE "barber_public_site_social_links" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barber_public_site_social_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "barber_public_site_social_links_provider_check" CHECK ("provider" IN ('instagram', 'facebook', 'tiktok', 'whatsapp', 'website', 'google_maps'))
);

-- CreateTable
CREATE TABLE "barber_public_site_instagram_posts" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barber_public_site_instagram_posts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "barber_public_site_instagram_posts_kind_check" CHECK ("kind" IN ('post', 'reel'))
);

-- CreateTable
CREATE TABLE "barber_public_site_stats" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barber_public_site_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "barber_public_site_highlights" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barber_public_site_highlights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "barber_public_sites_branchId_key" ON "barber_public_sites"("branchId");
CREATE UNIQUE INDEX "barber_public_sites_slug_key" ON "barber_public_sites"("slug");
CREATE INDEX "barber_public_sites_tenantId_idx" ON "barber_public_sites"("tenantId");
CREATE INDEX "barber_public_sites_branchId_status_idx" ON "barber_public_sites"("branchId", "status");
CREATE INDEX "barber_public_sites_slug_status_idx" ON "barber_public_sites"("slug", "status");
CREATE INDEX "barber_public_site_sections_siteId_sortOrder_idx" ON "barber_public_site_sections"("siteId", "sortOrder");
CREATE INDEX "barber_public_site_sections_siteId_type_idx" ON "barber_public_site_sections"("siteId", "type");
CREATE INDEX "barber_public_site_assets_siteId_kind_idx" ON "barber_public_site_assets"("siteId", "kind");
CREATE INDEX "barber_public_site_assets_siteId_sortOrder_idx" ON "barber_public_site_assets"("siteId", "sortOrder");
CREATE UNIQUE INDEX "barber_public_site_social_links_siteId_provider_key" ON "barber_public_site_social_links"("siteId", "provider");
CREATE INDEX "barber_public_site_social_links_siteId_sortOrder_idx" ON "barber_public_site_social_links"("siteId", "sortOrder");
CREATE INDEX "barber_public_site_instagram_posts_siteId_sortOrder_idx" ON "barber_public_site_instagram_posts"("siteId", "sortOrder");
CREATE INDEX "barber_public_site_stats_siteId_sortOrder_idx" ON "barber_public_site_stats"("siteId", "sortOrder");
CREATE INDEX "barber_public_site_highlights_siteId_sortOrder_idx" ON "barber_public_site_highlights"("siteId", "sortOrder");

-- AddForeignKey
ALTER TABLE "barber_public_sites" ADD CONSTRAINT "barber_public_sites_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "barber_public_sites" ADD CONSTRAINT "barber_public_sites_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "barber_public_site_sections" ADD CONSTRAINT "barber_public_site_sections_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "barber_public_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "barber_public_site_assets" ADD CONSTRAINT "barber_public_site_assets_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "barber_public_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "barber_public_site_social_links" ADD CONSTRAINT "barber_public_site_social_links_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "barber_public_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "barber_public_site_instagram_posts" ADD CONSTRAINT "barber_public_site_instagram_posts_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "barber_public_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "barber_public_site_stats" ADD CONSTRAINT "barber_public_site_stats_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "barber_public_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "barber_public_site_highlights" ADD CONSTRAINT "barber_public_site_highlights_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "barber_public_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed editor sites from the existing barber settings rows.
INSERT INTO "barber_public_sites" (
    "id", "tenantId", "branchId", "slug", "status", "publishedAt",
    "seoTitle", "seoDescription", "ogImageUrl",
    "themePrimary", "themeAccent", "themeInk",
    "shortName", "neighborhood", "city", "phone", "whatsapp",
    "createdAt", "updatedAt"
)
SELECT
    (gen_random_uuid())::text,
    bs."tenantId",
    bs."branchId",
    bs."bookingSlug",
    CASE WHEN bs."publicProfilePublished" THEN 'published' ELSE 'draft' END,
    CASE WHEN bs."publicProfilePublished" THEN bs."updatedAt" ELSE NULL END,
    COALESCE(bs."heroTitle", t."name"),
    COALESCE(bs."description", bs."heroDescription"),
    COALESCE(bs."heroImageUrl", bs."themeBannerImageUrl"),
    bs."themePrimaryColor",
    bs."themeAccentColor",
    bs."themeInkColor",
    bs."shortName",
    bs."neighborhood",
    bs."city",
    bs."phone",
    bs."whatsapp",
    bs."createdAt",
    bs."updatedAt"
FROM "barber_settings" bs
JOIN "tenants" t ON t."id" = bs."tenantId"
ON CONFLICT ("branchId") DO NOTHING;

INSERT INTO "barber_public_site_sections" (
    "id", "siteId", "type", "isVisible", "sortOrder", "width", "density",
    "title", "eyebrow", "subtitle", "body", "ctaLabel", "ctaAction", "settings"
)
SELECT (gen_random_uuid())::text, site."id", section."type", section."isVisible", section."sortOrder",
       section."width", section."density", section."title", section."eyebrow", section."subtitle",
       section."body", section."ctaLabel", section."ctaAction", section."settings"::jsonb
FROM "barber_public_sites" site
JOIN "barber_settings" bs ON bs."branchId" = site."branchId"
JOIN "tenants" t ON t."id" = site."tenantId"
CROSS JOIN LATERAL (
    VALUES
      ('hero', true, 10, 'full', 'immersive', COALESCE(bs."heroTitle", t."name"), bs."eyebrow", bs."heroDescription", bs."description", 'Reservar cita', 'open_booking', '{}'),
      ('services', true, 20, 'contained', 'comfortable', 'Servicios', NULL, 'Elige el servicio que necesitas.', NULL, 'Reservar', 'open_booking', '{"initialVisible": 6}'),
      ('gallery', true, 30, 'wide', 'comfortable', 'Galeria', NULL, NULL, NULL, NULL, NULL, '{}'),
      ('instagram', bs."instagramProfileUrl" IS NOT NULL, 40, 'contained', 'comfortable', 'Instagram', NULL, NULL, NULL, NULL, NULL, '{}'),
      ('booking_cta', true, 50, 'contained', 'comfortable', 'Agenda tu cita', NULL, 'Reserva online sin filas.', NULL, 'Reservar ahora', 'open_booking', '{}'),
      ('contact', true, 60, 'contained', 'compact', 'Contacto', NULL, NULL, NULL, NULL, NULL, '{}')
) AS section("type", "isVisible", "sortOrder", "width", "density", "title", "eyebrow", "subtitle", "body", "ctaLabel", "ctaAction", "settings");

INSERT INTO "barber_public_site_assets" (
    "id", "siteId", "kind", "url", "alt", "fit", "focalPoint", "sortOrder"
)
SELECT (gen_random_uuid())::text, site."id", asset."kind", asset."url", asset."alt", asset."fit", asset."focalPoint", asset."sortOrder"
FROM "barber_public_sites" site
JOIN "barber_settings" bs ON bs."branchId" = site."branchId"
CROSS JOIN LATERAL (
    VALUES
      ('logo', COALESCE(bs."themeLogoImageUrl", bs."logoUrl"), 'Logo', 'contain', 'center', 10),
      ('hero', COALESCE(bs."heroImageUrl", bs."themeBannerImageUrl"), 'Imagen principal', 'cover', 'center', 20)
) AS asset("kind", "url", "alt", "fit", "focalPoint", "sortOrder")
WHERE asset."url" IS NOT NULL AND asset."url" <> '';

INSERT INTO "barber_public_site_social_links" (
    "id", "siteId", "provider", "label", "url", "isVisible", "sortOrder"
)
SELECT (gen_random_uuid())::text, site."id", social."provider", social."label", social."url", true, social."sortOrder"
FROM "barber_public_sites" site
JOIN "barber_settings" bs ON bs."branchId" = site."branchId"
CROSS JOIN LATERAL (
    VALUES
      ('instagram', 'Instagram', bs."socialInstagram", 10),
      ('facebook', 'Facebook', bs."socialFacebook", 20),
      ('tiktok', 'TikTok', bs."socialTiktok", 30),
      ('website', 'Sitio web', bs."socialWebsite", 40)
) AS social("provider", "label", "url", "sortOrder")
WHERE social."url" IS NOT NULL AND social."url" <> '';
