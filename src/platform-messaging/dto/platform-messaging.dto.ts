import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export const MESSAGE_CHANNELS = ['whatsapp', 'email'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const PAYMENT_METHOD_KINDS = [
  'breb',
  'nequi',
  'bank_transfer',
  'link',
  'cash',
] as const;

export class UpdateTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpsertPaymentMethodDto {
  @ApiProperty({ enum: PAYMENT_METHOD_KINDS })
  @IsIn(PAYMENT_METHOD_KINDS as unknown as string[])
  kind!: string;

  @ApiProperty({ example: 'Bre-B · Nu' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label!: string;

  @ApiPropertyOptional({ example: '@DCU963' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  holder?: string;

  @ApiPropertyOptional({ example: 'Nu Colombia' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  bank?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  accountType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  document?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(400)
  instructions?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  qrImageUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  qrPdfUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateMessagingSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  waEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @ApiPropertyOptional({ example: 'cobros@uselynko.com' })
  @IsOptional()
  @IsEmail()
  fromEmail?: string;

  @ApiPropertyOptional({ example: 'Lynko' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fromName?: string;

  @ApiPropertyOptional({ example: 'soporte@uselynko.com' })
  @IsOptional()
  @IsEmail()
  replyTo?: string;

  @ApiPropertyOptional({
    description:
      'API key de Resend. Vacío = no se toca la guardada. Nunca se devuelve por la API.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  // Toda key de Resend empieza por `re_`. Sin esta validación, un autocompletado
  // del navegador (que pisa el campo con una contraseña guardada) se persiste
  // como si fuera válido y el fallo recién aparece al primer envío.
  @Matches(/^re_[A-Za-z0-9_-]{10,}$/, {
    message:
      'La API key de Resend debe empezar por "re_". Revisa que no se haya autocompletado otra cosa en el campo.',
  })
  resendApiKey?: string;

  @ApiPropertyOptional({ description: 'true borra la API key guardada.' })
  @IsOptional()
  @IsBoolean()
  clearApiKey?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  signature?: string;
}

export class PreviewMessageDto {
  @ApiProperty({ example: 'payment_reminder' })
  @IsString()
  templateKey!: string;

  @ApiProperty({ enum: MESSAGE_CHANNELS, isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(MESSAGE_CHANNELS as unknown as string[], { each: true })
  channels!: MessageChannel[];
}

export class SendMessageDto extends PreviewMessageDto {
  @ApiPropertyOptional({
    description:
      'Texto editado a mano en el diálogo; reemplaza el renderizado.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  bodyOverride?: string;

  @ApiPropertyOptional({
    description: 'Adjunta el QR del medio de pago por defecto.',
  })
  @IsOptional()
  @IsBoolean()
  includeQr?: boolean;
}

export class SendTestEmailDto {
  @ApiProperty()
  @IsEmail()
  to!: string;
}
