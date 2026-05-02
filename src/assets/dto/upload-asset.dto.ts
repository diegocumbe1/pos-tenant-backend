import { IsIn, IsOptional, IsString } from 'class-validator';

export class UploadAssetDto {
  @IsIn(['menu', 'product'])
  scope!: 'menu' | 'product';

  @IsIn(['logo', 'banner', 'product-image'])
  kind!: 'logo' | 'banner' | 'product-image';

  @IsOptional()
  @IsString()
  entityId?: string;
}

export class DeleteAssetDto {
  @IsString()
  path!: string;
}
