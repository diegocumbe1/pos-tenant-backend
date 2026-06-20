-- AlterTable
ALTER TABLE "public_sites" ADD COLUMN     "themeBackgroundType" TEXT,
ADD COLUMN     "themeFaviconUrl" TEXT,
ADD COLUMN     "themeFontStyle" TEXT,
ADD COLUMN     "themeLogoUrl" TEXT,
ADD COLUMN     "themeMode" TEXT,
ADD COLUMN     "themeSecondary" TEXT,
ADD COLUMN     "themeWhatsapp" JSONB;
