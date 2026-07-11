import { IsIn, IsOptional, IsString } from 'class-validator';

export class UploadAssetDto {
  @IsIn(['menu', 'product', 'payment'])
  scope!: 'menu' | 'product' | 'payment';

  @IsIn(['logo', 'banner', 'product-image', 'payment-qr'])
  kind!: 'logo' | 'banner' | 'product-image' | 'payment-qr';

  @IsOptional()
  @IsString()
  entityId?: string;
}

export class DeleteAssetDto {
  @IsString()
  path!: string;
}

export class UploadCatalogImagesDto {
  @IsOptional()
  @IsIn(['append', 'replace'])
  mode?: 'append' | 'replace';
}
