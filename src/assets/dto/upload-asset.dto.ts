import { IsIn, IsOptional, IsString } from 'class-validator';

export class UploadAssetDto {
  // 'shipment' son los soportes de un envío: foto de la guía, comprobante del
  // flete o el PDF de la transportadora. Acepta imagen y PDF, como 'payment'.
  @IsIn(['menu', 'product', 'payment', 'shipment'])
  scope!: 'menu' | 'product' | 'payment' | 'shipment';

  @IsIn(['logo', 'banner', 'product-image', 'payment-qr', 'shipment-support'])
  kind!:
    | 'logo'
    | 'banner'
    | 'product-image'
    | 'payment-qr'
    | 'shipment-support';

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
