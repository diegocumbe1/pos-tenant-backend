-- Generalize the barber-specific public site builder into a vertical-agnostic
-- "PublicSite" feature. This renames tables + all Prisma-managed objects
-- (PK / FK / unique / index / check) so the schema stays consistent and a
-- future `prisma migrate dev` detects no drift. No data is dropped.

-- ── Rename tables ────────────────────────────────────────────────────────────
ALTER TABLE "barber_public_sites" RENAME TO "public_sites";
ALTER TABLE "barber_public_site_sections" RENAME TO "public_site_sections";
ALTER TABLE "barber_public_site_assets" RENAME TO "public_site_assets";
ALTER TABLE "barber_public_site_social_links" RENAME TO "public_site_social_links";
ALTER TABLE "barber_public_site_instagram_posts" RENAME TO "public_site_instagram_posts";
ALTER TABLE "barber_public_site_stats" RENAME TO "public_site_stats";
ALTER TABLE "barber_public_site_highlights" RENAME TO "public_site_highlights";

-- ── Rename constraints: public_sites ────────────────────────────────────────
ALTER TABLE "public_sites" RENAME CONSTRAINT "barber_public_sites_pkey" TO "public_sites_pkey";
ALTER TABLE "public_sites" RENAME CONSTRAINT "barber_public_sites_status_check" TO "public_sites_status_check";
ALTER TABLE "public_sites" RENAME CONSTRAINT "barber_public_sites_themeRadius_check" TO "public_sites_themeRadius_check";
ALTER TABLE "public_sites" RENAME CONSTRAINT "barber_public_sites_tenantId_fkey" TO "public_sites_tenantId_fkey";
ALTER TABLE "public_sites" RENAME CONSTRAINT "barber_public_sites_branchId_fkey" TO "public_sites_branchId_fkey";

-- ── Rename constraints: public_site_sections ────────────────────────────────
ALTER TABLE "public_site_sections" RENAME CONSTRAINT "barber_public_site_sections_pkey" TO "public_site_sections_pkey";
ALTER TABLE "public_site_sections" RENAME CONSTRAINT "barber_public_site_sections_type_check" TO "public_site_sections_type_check";
ALTER TABLE "public_site_sections" RENAME CONSTRAINT "barber_public_site_sections_width_check" TO "public_site_sections_width_check";
ALTER TABLE "public_site_sections" RENAME CONSTRAINT "barber_public_site_sections_density_check" TO "public_site_sections_density_check";
ALTER TABLE "public_site_sections" RENAME CONSTRAINT "barber_public_site_sections_ctaAction_check" TO "public_site_sections_ctaAction_check";
ALTER TABLE "public_site_sections" RENAME CONSTRAINT "barber_public_site_sections_siteId_fkey" TO "public_site_sections_siteId_fkey";

-- ── Rename constraints: public_site_assets ──────────────────────────────────
ALTER TABLE "public_site_assets" RENAME CONSTRAINT "barber_public_site_assets_pkey" TO "public_site_assets_pkey";
ALTER TABLE "public_site_assets" RENAME CONSTRAINT "barber_public_site_assets_kind_check" TO "public_site_assets_kind_check";
ALTER TABLE "public_site_assets" RENAME CONSTRAINT "barber_public_site_assets_fit_check" TO "public_site_assets_fit_check";
ALTER TABLE "public_site_assets" RENAME CONSTRAINT "barber_public_site_assets_focalPoint_check" TO "public_site_assets_focalPoint_check";
ALTER TABLE "public_site_assets" RENAME CONSTRAINT "barber_public_site_assets_siteId_fkey" TO "public_site_assets_siteId_fkey";

-- ── Rename constraints: public_site_social_links ────────────────────────────
ALTER TABLE "public_site_social_links" RENAME CONSTRAINT "barber_public_site_social_links_pkey" TO "public_site_social_links_pkey";
ALTER TABLE "public_site_social_links" RENAME CONSTRAINT "barber_public_site_social_links_provider_check" TO "public_site_social_links_provider_check";
ALTER TABLE "public_site_social_links" RENAME CONSTRAINT "barber_public_site_social_links_siteId_fkey" TO "public_site_social_links_siteId_fkey";

-- ── Rename constraints: public_site_instagram_posts ─────────────────────────
ALTER TABLE "public_site_instagram_posts" RENAME CONSTRAINT "barber_public_site_instagram_posts_pkey" TO "public_site_instagram_posts_pkey";
ALTER TABLE "public_site_instagram_posts" RENAME CONSTRAINT "barber_public_site_instagram_posts_kind_check" TO "public_site_instagram_posts_kind_check";
ALTER TABLE "public_site_instagram_posts" RENAME CONSTRAINT "barber_public_site_instagram_posts_siteId_fkey" TO "public_site_instagram_posts_siteId_fkey";

-- ── Rename constraints: public_site_stats ───────────────────────────────────
ALTER TABLE "public_site_stats" RENAME CONSTRAINT "barber_public_site_stats_pkey" TO "public_site_stats_pkey";
ALTER TABLE "public_site_stats" RENAME CONSTRAINT "barber_public_site_stats_siteId_fkey" TO "public_site_stats_siteId_fkey";

-- ── Rename constraints: public_site_highlights ──────────────────────────────
ALTER TABLE "public_site_highlights" RENAME CONSTRAINT "barber_public_site_highlights_pkey" TO "public_site_highlights_pkey";
ALTER TABLE "public_site_highlights" RENAME CONSTRAINT "barber_public_site_highlights_siteId_fkey" TO "public_site_highlights_siteId_fkey";

-- ── Rename indexes ──────────────────────────────────────────────────────────
ALTER INDEX "barber_public_sites_branchId_key" RENAME TO "public_sites_branchId_key";
ALTER INDEX "barber_public_sites_slug_key" RENAME TO "public_sites_slug_key";
ALTER INDEX "barber_public_sites_tenantId_idx" RENAME TO "public_sites_tenantId_idx";
ALTER INDEX "barber_public_sites_branchId_status_idx" RENAME TO "public_sites_branchId_status_idx";
ALTER INDEX "barber_public_sites_slug_status_idx" RENAME TO "public_sites_slug_status_idx";
ALTER INDEX "barber_public_sites_slug_published_snapshot_idx" RENAME TO "public_sites_slug_published_snapshot_idx";
ALTER INDEX "barber_public_sites_publishedSlug_key" RENAME TO "public_sites_publishedSlug_key";
ALTER INDEX "barber_public_sites_publishedSlug_status_idx" RENAME TO "public_sites_publishedSlug_status_idx";
ALTER INDEX "barber_public_site_sections_siteId_sortOrder_idx" RENAME TO "public_site_sections_siteId_sortOrder_idx";
ALTER INDEX "barber_public_site_sections_siteId_type_idx" RENAME TO "public_site_sections_siteId_type_idx";
ALTER INDEX "barber_public_site_assets_siteId_kind_idx" RENAME TO "public_site_assets_siteId_kind_idx";
ALTER INDEX "barber_public_site_assets_siteId_sortOrder_idx" RENAME TO "public_site_assets_siteId_sortOrder_idx";
ALTER INDEX "barber_public_site_social_links_siteId_provider_key" RENAME TO "public_site_social_links_siteId_provider_key";
ALTER INDEX "barber_public_site_social_links_siteId_sortOrder_idx" RENAME TO "public_site_social_links_siteId_sortOrder_idx";
ALTER INDEX "barber_public_site_instagram_posts_siteId_sortOrder_idx" RENAME TO "public_site_instagram_posts_siteId_sortOrder_idx";
ALTER INDEX "barber_public_site_stats_siteId_sortOrder_idx" RENAME TO "public_site_stats_siteId_sortOrder_idx";
ALTER INDEX "barber_public_site_highlights_siteId_sortOrder_idx" RENAME TO "public_site_highlights_siteId_sortOrder_idx";

-- ── Add vertical discriminator (existing rows are barbershops) ───────────────
ALTER TABLE "public_sites" ADD COLUMN "vertical" TEXT NOT NULL DEFAULT 'barber';
