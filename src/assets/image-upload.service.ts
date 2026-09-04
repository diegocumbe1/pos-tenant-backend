import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
// sharp se exporta como `module.exports = sharp` (CommonJS). Sin
// `esModuleInterop: true` en tsconfig, `import sharp from 'sharp'` compila a
// `sharp_1.default(...)` que es undefined en runtime. La sintaxis
// `import = require` es el equivalente correcto en TS-CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import sharp = require('sharp');

export type UploadedImageFile = {
  buffer?: Buffer;
  mimetype?: string;
  size?: number;
  originalname?: string;
  /** Multer marca true cuando recortó el archivo por exceder `limits.fileSize`. */
  truncated?: boolean;
};

/**
 * Categoría lógica de la imagen. Determina:
 *  - Dimensiones mínimas exigidas al usuario.
 *  - Ancho máximo de salida (la altura se ajusta proporcional).
 * Usar `'default'` cuando no encaja en ninguna categoría conocida.
 */
export type ImageKind =
  | 'logo'
  | 'hero'
  | 'gallery'
  | 'background'
  | 'thumbnail'
  | 'service'
  | 'section'
  | 'document'
  | 'default';

export type ImageUploadInput = {
  file: UploadedImageFile;
  /**
   * Carpeta destino dentro del bucket (sin trailing slash, sin filename).
   * Ej. `tenants/<tenantId>/barber/services/<serviceId>`.
   * El service appendea `<timestamp>-<uuid>.webp`.
   */
  pathPrefix: string;
  kind?: ImageKind;
  /**
   * Override del ancho máximo de salida. Si se omite, usa el del `kind`.
   */
  maxWidth?: number;
};

export type ImageUploadResult = {
  bucket: string;
  path: string;
  publicUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
  contentType: 'image/webp';
};

export type FileUploadResult = {
  bucket: string;
  path: string;
  publicUrl: string;
  sizeBytes: number;
  contentType: 'application/pdf';
};

const MAX_INPUT_SIZE_BYTES = 5 * 1024 * 1024;
const PDF_HEADER = '%PDF-';
const ALLOWED_INPUT_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const MIN_DIMENSIONS: Record<ImageKind, { width: number; height: number }> = {
  logo: { width: 128, height: 128 },
  hero: { width: 1200, height: 600 },
  gallery: { width: 640, height: 480 },
  background: { width: 1200, height: 600 },
  thumbnail: { width: 320, height: 240 },
  service: { width: 640, height: 480 },
  section: { width: 640, height: 480 },
  // SIN MÍNIMO A PROPÓSITO. Un soporte es la foto de una guía, el pantallazo de
  // un chat o el recorte de un comprobante: nace del tamaño que sea, y ese
  // tamaño no es negociable con quien lo mandó. Exigirle 640x480 rechazaba
  // pantallazos perfectamente legibles —el caso real fue uno de 603x414— y
  // dejaba al dueño sin poder guardar el único respaldo que tenía del flete.
  // Que se vea borroso es su problema; que no se pueda guardar es el nuestro.
  document: { width: 1, height: 1 },
  default: { width: 480, height: 320 },
};

const MAX_WIDTHS: Record<ImageKind, number> = {
  logo: 512,
  hero: 1920,
  gallery: 1600,
  background: 1920,
  thumbnail: 640,
  service: 1600,
  section: 1600,
  // El tope alto sí se mantiene: el número de una guía tiene que poder leerse.
  // Reescalar nunca agranda, así que un pantallazo chico entra tal cual.
  document: 1600,
  default: 1600,
};

const WEBP_QUALITY = 80;
const WEBP_EFFORT = 4;

/**
 * Servicio compartido para validar, optimizar (WebP) y subir imágenes a
 * Supabase Storage. Lo usan todos los flujos de upload de archivo (public-site
 * assets, barber service assets, info_cards, etc.).
 *
 * Convenciones del bucket — ver `docs/STORAGE_LAYOUT.md`:
 *   tenants/<tenantId>/<vertical>/<resource>/<resourceId>/<filename>.webp
 *
 * Comportamiento:
 *  - Acepta sólo image/jpeg, image/png, image/webp (máx. 5 MB).
 *  - Valida que el mimetype declarado coincida con los bytes reales.
 *  - Auto-rota por EXIF (fotos de móvil quedan derechas).
 *  - Reescala al ancho máximo de su `kind` (sin upscale).
 *  - Convierte SIEMPRE a WebP (quality=80, effort=4) — más liviano que JPEG.
 *  - Sube a Supabase con `<timestamp>-<uuid>.webp` para evitar colisiones.
 */
@Injectable()
export class ImageUploadService {
  private readonly logger = new Logger(ImageUploadService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async uploadImage(input: ImageUploadInput): Promise<ImageUploadResult> {
    const file = input.file;
    this.assertInputFile(file);

    const kind: ImageKind = input.kind ?? 'default';
    const maxWidth = input.maxWidth ?? MAX_WIDTHS[kind];

    const buffer = file.buffer as Buffer;
    const metadata = await this.readMetadata(buffer, file.mimetype);
    this.assertMinDimensions(metadata, kind);

    const optimized = await sharp(buffer)
      .rotate()
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
      .toBuffer({ resolveWithObject: true });

    const filename = `${Date.now()}-${randomUUID()}.webp`;
    const path = `${this.normalizePrefix(input.pathPrefix)}/${filename}`;

    const uploaded = await this.supabase.uploadPublicAsset({
      path,
      buffer: optimized.data,
      contentType: 'image/webp',
    });

    this.logger.log(
      `image uploaded kind=${kind} path=${uploaded.path} ` +
        `inputBytes=${buffer.length} outputBytes=${optimized.info.size} ` +
        `dims=${optimized.info.width}x${optimized.info.height}`,
    );

    return {
      bucket: uploaded.bucket,
      path: uploaded.path,
      publicUrl: uploaded.publicUrl,
      width: optimized.info.width,
      height: optimized.info.height,
      sizeBytes: optimized.info.size,
      contentType: 'image/webp',
    };
  }

  async uploadPdf(
    input: Omit<ImageUploadInput, 'kind' | 'maxWidth'>,
  ): Promise<FileUploadResult> {
    const file = input.file;
    this.assertPdfFile(file);

    const buffer = file.buffer as Buffer;
    const filename = `${Date.now()}-${randomUUID()}.pdf`;
    const path = `${this.normalizePrefix(input.pathPrefix)}/${filename}`;

    const uploaded = await this.supabase.uploadPublicAsset({
      path,
      buffer,
      contentType: 'application/pdf',
    });

    this.logger.log(
      `pdf uploaded path=${uploaded.path} inputBytes=${buffer.length}`,
    );

    return {
      bucket: uploaded.bucket,
      path: uploaded.path,
      publicUrl: uploaded.publicUrl,
      sizeBytes: buffer.length,
      contentType: 'application/pdf',
    };
  }

  private assertInputFile(file: UploadedImageFile) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Falta el archivo de imagen');
    }
    // Multer corta el archivo en vez de rechazarlo cuando excede `limits.fileSize`.
    // Si llega truncado, sharp ve un stream incompleto y falla con "Invalid input".
    if (file.truncated) {
      throw new BadRequestException(
        'La imagen pesa más de 5 MB. Mándala más liviana o toma la foto en menor calidad.',
      );
    }
    if (file.size && file.size > MAX_INPUT_SIZE_BYTES) {
      throw new BadRequestException('La imagen debe pesar 5 MB o menos');
    }
    if (file.buffer.length > MAX_INPUT_SIZE_BYTES) {
      throw new BadRequestException('Image file must be 5 MB or smaller');
    }
    const declared = file.mimetype?.split(';')[0];
    if (!declared || !ALLOWED_INPUT_MIMES.has(declared)) {
      throw new BadRequestException(
        `Ese tipo de archivo no se puede subir ("${declared ?? 'desconocido'}"). Se aceptan JPG, PNG y WebP.`,
      );
    }
  }

  private assertPdfFile(file: UploadedImageFile) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Falta el archivo PDF');
    }
    if (file.truncated) {
      throw new BadRequestException(
        'El PDF pesa más de 5 MB. Mándalo más liviano.',
      );
    }
    if (file.size && file.size > MAX_INPUT_SIZE_BYTES) {
      throw new BadRequestException('El PDF debe pesar 5 MB o menos');
    }
    if (file.buffer.length > MAX_INPUT_SIZE_BYTES) {
      throw new BadRequestException('PDF file must be 5 MB or smaller');
    }
    const declared = file.mimetype?.split(';')[0];
    if (declared !== 'application/pdf') {
      throw new BadRequestException(
        `Unsupported payment QR file type "${declared ?? 'unknown'}". Allowed: image/jpeg, image/png, image/webp, application/pdf`,
      );
    }
    if (
      file.buffer.subarray(0, PDF_HEADER.length).toString('utf8') !== PDF_HEADER
    ) {
      throw new BadRequestException('El archivo no es un PDF válido');
    }
  }

  private async readMetadata(buffer: Buffer, declaredMime?: string) {
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(buffer).metadata();
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(
        `sharp failed to read image bufferLength=${buffer.length} declaredMime=${declaredMime ?? 'unknown'} firstBytes=${buffer
          .subarray(0, 16)
          .toString('hex')} reason=${reason}`,
      );
      throw new BadRequestException(
        'No se pudo leer la imagen. Puede estar dañada o incompleta.',
      );
    }

    const format = metadata.format;
    const detectedMime =
      format === 'jpeg' || format === 'jpg'
        ? 'image/jpeg'
        : format === 'png'
          ? 'image/png'
          : format === 'webp'
            ? 'image/webp'
            : null;

    if (!detectedMime || !ALLOWED_INPUT_MIMES.has(detectedMime)) {
      throw new BadRequestException(
        `Se aceptan JPG, PNG y WebP (este archivo es ${format ?? 'de un tipo desconocido'}).`,
      );
    }
    if (declaredMime && declaredMime.split(';')[0] !== detectedMime) {
      throw new BadRequestException(
        `El archivo dice ser ${declaredMime} pero por dentro es ${detectedMime}. Vuelve a guardarlo y súbelo otra vez.`,
      );
    }
    if (!metadata.width || !metadata.height) {
      throw new BadRequestException(
        'No se pudo leer la imagen. Puede estar dañada.',
      );
    }
    return { width: metadata.width, height: metadata.height };
  }

  private assertMinDimensions(
    metadata: { width: number; height: number },
    kind: ImageKind,
  ) {
    const min = MIN_DIMENSIONS[kind];
    if (metadata.width < min.width || metadata.height < min.height) {
      throw new BadRequestException({
        code: 'IMAGE_DIMENSIONS_TOO_SMALL',
        message: `La imagen es muy pequeña: debe tener al menos ${min.width}x${min.height} píxeles y esta tiene ${metadata.width}x${metadata.height}.`,
        minWidth: min.width,
        minHeight: min.height,
        width: metadata.width,
        height: metadata.height,
      });
    }
  }

  private normalizePrefix(prefix: string): string {
    return prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  }
}
