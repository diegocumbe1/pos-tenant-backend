import {
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class MenuPublicThemeDto {
  @IsOptional()
  @IsString()
  templateId?: string;

  @IsOptional()
  @IsString()
  primaryColor?: string;

  @IsOptional()
  @IsString()
  accentColor?: string;

  @IsOptional()
  @IsString()
  bannerText?: string;

  @IsOptional()
  @IsString()
  logoMode?: string;

  @IsOptional()
  @IsString()
  logoVariant?: string;

  @IsOptional()
  @IsString()
  logoFit?: string;

  @IsOptional()
  @IsString()
  logoEmoji?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  logoImageUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  bannerImageUrl?: string;

  @IsOptional()
  @IsString()
  heroKicker?: string;

  @IsOptional()
  @IsString()
  heroTitle?: string;

  @IsOptional()
  @IsString()
  heroDescription?: string;

  @IsOptional()
  @IsString()
  featuredTitle?: string;

  @IsOptional()
  @IsString()
  featuredDescription?: string;
}

export class UpdateMenuPublicConfigDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[a-z0-9-]+$/)
  slug?: string;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  @IsOptional()
  @IsBoolean()
  showPrices?: boolean;

  @IsOptional()
  @IsBoolean()
  showDescription?: boolean;

  @IsOptional()
  @IsBoolean()
  showImages?: boolean;

  @IsOptional()
  @IsBoolean()
  showUnavailable?: boolean;

  @IsOptional()
  @IsBoolean()
  showFeaturedBadge?: boolean;

  @IsOptional()
  @IsBoolean()
  showRatings?: boolean;

  @IsOptional()
  @IsBoolean()
  showSavedCount?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  featuredProductIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoryOrder?: string[];

  @IsOptional()
  @IsObject()
  theme?: MenuPublicThemeDto;
}

export class PublishMenuPublicConfigDto {
  @IsBoolean()
  isPublished!: boolean;
}
