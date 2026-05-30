import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsHexColor,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class UpdateBarberBusinessDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  businessName?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  branchName?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  neighborhood?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  whatsapp?: string;
}

export class BarberThemeDto {
  @IsOptional()
  @IsString()
  templateId?: string;

  @IsOptional()
  @IsHexColor()
  primaryColor?: string;

  @IsOptional()
  @IsHexColor()
  accentColor?: string;

  @IsOptional()
  @IsHexColor()
  inkColor?: string;

  @IsOptional()
  @IsString()
  logoMode?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  logoImageUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  bannerImageUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  heroImageUrl?: string;

  @IsOptional()
  @IsString()
  heroTitle?: string;

  @IsOptional()
  @IsString()
  heroDescription?: string;
}

export class BarberBrochureCopyDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  shortName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  tagline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  eyebrow?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(12)
  highlights?: string[];
}

export class BarberStatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  value!: string;
}

export class BarberGalleryItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @IsUrl({ require_tld: false })
  imageUrl!: string;
}

export class BarberSocialsDto {
  @IsOptional()
  @IsString()
  instagram?: string;

  @IsOptional()
  @IsString()
  facebook?: string;

  @IsOptional()
  @IsString()
  tiktok?: string;

  @IsOptional()
  @IsString()
  website?: string;
}

export class BarberInstagramDto {
  @IsOptional()
  @IsUrl({ require_tld: false })
  profileUrl?: string;

  @IsOptional()
  @IsArray()
  @IsUrl({ require_tld: false }, { each: true })
  @ArrayMaxSize(20)
  posts?: string[];
}

export class UpdateBarberSettingsDto {
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => UpdateBarberBusinessDto)
  business?: UpdateBarberBusinessDto;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[a-z0-9-]+$/)
  bookingSlug?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsBoolean()
  onlineBookingEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  publicProfilePublished?: boolean;

  @IsOptional()
  @IsBoolean()
  whatsappEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  loyaltyEnabled?: boolean;

  @IsOptional()
  @IsUrl({ require_tld: false })
  logoUrl?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BarberThemeDto)
  theme?: BarberThemeDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BarberBrochureCopyDto)
  brochure?: BarberBrochureCopyDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BarberStatDto)
  @ArrayMaxSize(8)
  stats?: BarberStatDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BarberGalleryItemDto)
  @ArrayMaxSize(24)
  gallery?: BarberGalleryItemDto[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BarberSocialsDto)
  socials?: BarberSocialsDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BarberInstagramDto)
  instagram?: BarberInstagramDto;
}
