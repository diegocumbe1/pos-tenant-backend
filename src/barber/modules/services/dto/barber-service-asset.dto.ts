import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';

export const BARBER_SERVICE_ASSET_KINDS = [
  'primary',
  'gallery',
  'before',
  'after',
] as const;
export const BARBER_SERVICE_ASSET_FITS = ['cover', 'contain'] as const;
export const BARBER_SERVICE_ASSET_FOCALS = [
  'center',
  'top',
  'bottom',
  'left',
  'right',
] as const;

export class CreateBarberServiceAssetDto {
  @IsUrl({ require_tld: false })
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  alt?: string;

  @IsOptional()
  @IsIn(BARBER_SERVICE_ASSET_KINDS)
  kind?: (typeof BARBER_SERVICE_ASSET_KINDS)[number];

  @IsOptional()
  @IsIn(BARBER_SERVICE_ASSET_FITS)
  fit?: (typeof BARBER_SERVICE_ASSET_FITS)[number];

  @IsOptional()
  @IsIn(BARBER_SERVICE_ASSET_FOCALS)
  focalPoint?: (typeof BARBER_SERVICE_ASSET_FOCALS)[number];

  @IsOptional()
  @IsBoolean()
  showInPublicGallery?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/**
 * Form fields that accompany a multipart file upload to
 * POST /barber/services/:serviceId/assets/upload.
 * The file itself is sent as form field `file` (multipart/form-data).
 */
export class UploadBarberServiceAssetDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  alt?: string;

  @IsOptional()
  @IsIn(BARBER_SERVICE_ASSET_KINDS)
  kind?: (typeof BARBER_SERVICE_ASSET_KINDS)[number];

  @IsOptional()
  @IsIn(BARBER_SERVICE_ASSET_FITS)
  fit?: (typeof BARBER_SERVICE_ASSET_FITS)[number];

  @IsOptional()
  @IsIn(BARBER_SERVICE_ASSET_FOCALS)
  focalPoint?: (typeof BARBER_SERVICE_ASSET_FOCALS)[number];

  @IsOptional()
  @IsBoolean()
  showInPublicGallery?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateBarberServiceAssetDto {
  @IsOptional()
  @IsUrl({ require_tld: false })
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  alt?: string;

  @IsOptional()
  @IsIn(BARBER_SERVICE_ASSET_KINDS)
  kind?: (typeof BARBER_SERVICE_ASSET_KINDS)[number];

  @IsOptional()
  @IsIn(BARBER_SERVICE_ASSET_FITS)
  fit?: (typeof BARBER_SERVICE_ASSET_FITS)[number];

  @IsOptional()
  @IsIn(BARBER_SERVICE_ASSET_FOCALS)
  focalPoint?: (typeof BARBER_SERVICE_ASSET_FOCALS)[number];

  @IsOptional()
  @IsBoolean()
  showInPublicGallery?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
