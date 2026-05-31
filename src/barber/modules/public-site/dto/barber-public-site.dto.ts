import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const PUBLIC_SITE_STATUSES = ['draft', 'published'] as const;
export const PUBLIC_SITE_SECTION_TYPES = [
  'hero',
  'trust_bar',
  'services',
  'catalog',
  'gallery',
  'instagram',
  'info_cards',
  'booking_cta',
  'booking_modal',
  'contact',
] as const;
export const PUBLIC_SITE_ASSET_KINDS = [
  'logo',
  'hero',
  'gallery',
  'background',
  'thumbnail',
] as const;
export const PUBLIC_IMAGE_FITS = ['cover', 'contain'] as const;
export const PUBLIC_IMAGE_FOCAL_POINTS = [
  'center',
  'top',
  'bottom',
  'left',
  'right',
] as const;
export const PUBLIC_SECTION_WIDTHS = ['contained', 'wide', 'full'] as const;
export const PUBLIC_SECTION_DENSITIES = [
  'compact',
  'comfortable',
  'immersive',
] as const;
export const PUBLIC_CTA_ACTIONS = [
  'open_booking',
  'scroll_services',
  'open_whatsapp',
  'external_link',
] as const;
export const PUBLIC_SOCIAL_PROVIDERS = [
  'instagram',
  'facebook',
  'tiktok',
  'whatsapp',
  'website',
  'google_maps',
] as const;

export class UpdatePublicSiteSeoDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  description?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  ogImageUrl?: string;
}

export class UpdatePublicSiteThemeDto {
  @IsOptional()
  @IsHexColor()
  primary?: string;

  @IsOptional()
  @IsHexColor()
  accent?: string;

  @IsOptional()
  @IsHexColor()
  ink?: string;

  @IsOptional()
  @IsHexColor()
  background?: string;

  @IsOptional()
  @IsHexColor()
  surface?: string;

  @IsOptional()
  @IsIn(['sm', 'md', 'lg'])
  radius?: 'sm' | 'md' | 'lg';
}

export class UpdatePublicSiteBusinessDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  shortName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  neighborhood?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  whatsapp?: string;
}

export class UpdatePublicSiteDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[a-z0-9-]+$/)
  slug?: string;

  @IsOptional()
  @IsIn(PUBLIC_SITE_STATUSES)
  status?: 'draft' | 'published';

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => UpdatePublicSiteSeoDto)
  seo?: UpdatePublicSiteSeoDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => UpdatePublicSiteThemeDto)
  theme?: UpdatePublicSiteThemeDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => UpdatePublicSiteBusinessDto)
  business?: UpdatePublicSiteBusinessDto;
}

export class PublicSiteSectionDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsIn(PUBLIC_SITE_SECTION_TYPES)
  type!: string;

  @IsBoolean()
  isVisible!: boolean;

  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder!: number;

  @IsIn(PUBLIC_SECTION_WIDTHS)
  width!: string;

  @IsIn(PUBLIC_SECTION_DENSITIES)
  density!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  eyebrow?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  subtitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  ctaLabel?: string;

  @IsOptional()
  @IsIn(PUBLIC_CTA_ACTIONS)
  ctaAction?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  ctaHref?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(24)
  assetIds?: string[];

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

export class ReplacePublicSiteSectionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PublicSiteSectionDto)
  @ArrayMaxSize(24)
  sections!: PublicSiteSectionDto[];
}

export class UploadPublicSiteAssetDto {
  @IsIn(PUBLIC_SITE_ASSET_KINDS)
  kind!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  alt!: string;

  @IsOptional()
  @IsIn(PUBLIC_IMAGE_FITS)
  fit?: string;

  @IsOptional()
  @IsIn(PUBLIC_IMAGE_FOCAL_POINTS)
  focalPoint?: string;
}

export class CreatePublicSiteAssetFromUrlDto extends UploadPublicSiteAssetDto {
  @Matches(/^(https?:\/\/[^\s]+|data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+)$/)
  url!: string;
}

export class UpdatePublicSiteAssetDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  alt?: string;

  @IsOptional()
  @IsIn(PUBLIC_IMAGE_FITS)
  fit?: string;

  @IsOptional()
  @IsIn(PUBLIC_IMAGE_FOCAL_POINTS)
  focalPoint?: string;

  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class PublicSiteSocialLinkDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsIn(PUBLIC_SOCIAL_PROVIDERS)
  provider!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label!: string;

  @IsUrl({ require_tld: false })
  url!: string;

  @IsBoolean()
  isVisible!: boolean;

  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder!: number;
}

export class ReplacePublicSiteSocialsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PublicSiteSocialLinkDto)
  @ArrayMaxSize(12)
  socials!: PublicSiteSocialLinkDto[];
}

export class PublicSiteInstagramPostDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsUrl({ require_tld: false })
  url!: string;

  @IsIn(['post', 'reel'])
  kind!: string;

  @IsBoolean()
  isVisible!: boolean;

  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder!: number;
}

export class ReplacePublicSiteInstagramDto {
  @IsOptional()
  @IsUrl({ require_tld: false })
  profileUrl?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PublicSiteInstagramPostDto)
  @ArrayMaxSize(20)
  posts!: PublicSiteInstagramPostDto[];
}

export class PublicSiteStatDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  value!: string;

  @IsBoolean()
  isVisible!: boolean;

  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder!: number;
}

export class ReplacePublicSiteStatsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PublicSiteStatDto)
  @ArrayMaxSize(8)
  stats!: PublicSiteStatDto[];
}

export class PublicSiteHighlightDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label!: string;

  @IsBoolean()
  isVisible!: boolean;

  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder!: number;
}

export class ReplacePublicSiteHighlightsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PublicSiteHighlightDto)
  @ArrayMaxSize(12)
  highlights!: PublicSiteHighlightDto[];
}
