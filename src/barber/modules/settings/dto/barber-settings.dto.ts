import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class TimeRangeDto {
  @Matches(HHMM, { message: 'start must be HH:MM (24h)' })
  start!: string;

  @Matches(HHMM, { message: 'end must be HH:MM (24h)' })
  end!: string;
}

/**
 * Tenant-editable wording for the public booking flow.  For example, a sports
 * venue can use "cancha/canchas" and "Reserva tu cancha" instead of the
 * barber-oriented service/cita vocabulary.
 */
export class PublicBookingCopyDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  itemSingular?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  itemPlural?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  bookingNoun?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  primaryCta?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  selectionPrompt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  schedulePrompt?: string;
}

export class BookingSettingsDto {
  @IsOptional()
  @IsString()
  @IsIn(['services', 'resources'])
  bookingMode?: 'services' | 'resources';

  @IsOptional()
  @IsBoolean()
  onlineBookingEnabled?: boolean;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => PublicBookingCopyDto)
  publicCopy?: PublicBookingCopyDto;

  // Horarios por día: { monday: [{start,end}], ... }. Lista vacía = cerrado.
  // Se valida/normaliza en el servicio porque las claves son dinámicas.
  @IsOptional()
  @IsObject()
  businessHours?: Record<string, TimeRangeDto[]>;
}

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
  @IsObject()
  @ValidateNested()
  @Type(() => BookingSettingsDto)
  booking?: BookingSettingsDto;

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
