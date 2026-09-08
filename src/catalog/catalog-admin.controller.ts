import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/types/tenant-context.interface';
import { PlatformActor } from '../platform/decorators/platform-actor.decorator';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard';
import {
  MAX_VIDEO_MB,
  UploadedImageFile,
} from '../assets/image-upload.service';
import { CatalogService } from './catalog.service';
import { CatalogPricingService } from './catalog-pricing.service';
import {
  BulkCatalogProductsDto,
  CreateCatalogDto,
  CreateCatalogProductDto,
  CreateCatalogServicePriceDto,
  ListCatalogsQueryDto,
  ReorderCatalogImagesDto,
  ReorderCatalogProductsDto,
  UpdateCatalogDto,
  UpdateCatalogProductDto,
} from './dto/catalog.dto';

/**
 * Catálogos gestionados, desde el backoffice.
 *
 * Guards: JwtAuthGuard → PlatformAdminGuard, el mismo par de
 * `platform.controller.ts`. NO usa TenantGuard ni X-Tenant-Id: un catálogo no
 * pertenece a ningún tenant —su dueño no tiene cuenta— y por eso solo lo puede
 * tocar el superadmin.
 *
 * Ver docs/CATALOGOS_GESTIONADOS_PLAN.md.
 */
@ApiTags('Catalogs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform/catalogs')
export class CatalogAdminController {
  constructor(
    private readonly catalogs: CatalogService,
    private readonly pricing: CatalogPricingService,
  ) {}

  // ─── Catálogo ──────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'Lista de catálogos gestionados' })
  list(@Query() query: ListCatalogsQueryDto) {
    return this.catalogs.list(query);
  }

  @Post()
  @ApiOperation({ summary: 'Crear catálogo (queda en borrador)' })
  create(@Body() dto: CreateCatalogDto) {
    return this.catalogs.create(dto);
  }

  // ─── Tarifas del servicio ──────────────────────────────────────────────────
  //
  // Van ANTES de `:id` a propósito: Nest resuelve por orden de declaración, y
  // con la ruta paramétrica arriba "pricing" entraría como si fuera el id de un
  // catálogo.

  @Get('pricing')
  @ApiOperation({ summary: 'Tarifas vigentes de los servicios de catálogo' })
  getPricing() {
    return this.pricing.getPricesAt();
  }

  @Get('pricing/history')
  @ApiOperation({ summary: 'Histórico de tarifas' })
  getPricingHistory(@Query('serviceCode') serviceCode?: string) {
    return this.pricing.getHistory(serviceCode);
  }

  @Post('pricing')
  @ApiOperation({
    summary: 'Nueva tarifa (append-only: no sobrescribe la anterior)',
  })
  createPrice(
    @Body() dto: CreateCatalogServicePriceDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.pricing.createPrice(dto, actor.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle con productos e imágenes' })
  get(@Param('id') id: string) {
    return this.catalogs.get(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Editar negocio, tema, SEO y datos comerciales' })
  update(@Param('id') id: string, @Body() dto: UpdateCatalogDto) {
    return this.catalogs.update(id, dto);
  }

  @Post(':id/publish')
  @ApiOperation({ summary: 'Publicar: el link queda en línea' })
  publish(@Param('id') id: string, @PlatformActor() actor: AuthenticatedUser) {
    return this.catalogs.publish(id, actor.id);
  }

  @Post(':id/unpublish')
  @ApiOperation({ summary: 'Volver a borrador' })
  unpublish(@Param('id') id: string) {
    return this.catalogs.unpublish(id);
  }

  @Post(':id/archive')
  @ApiOperation({
    summary: 'Cerrar temporada: deja de listarse, el link sigue vivo',
  })
  archive(@Param('id') id: string) {
    return this.catalogs.archive(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Borrar catálogo y sus imágenes del bucket' })
  remove(@Param('id') id: string) {
    return this.catalogs.remove(id);
  }

  // ─── Productos ─────────────────────────────────────────────────────────────

  @Post(':id/products')
  @ApiOperation({ summary: 'Agregar producto' })
  addProduct(@Param('id') id: string, @Body() dto: CreateCatalogProductDto) {
    return this.catalogs.addProduct(id, dto);
  }

  @Post(':id/products/bulk')
  @ApiOperation({ summary: 'Cargar varios productos de una (carga inicial)' })
  addProductsBulk(
    @Param('id') id: string,
    @Body() dto: BulkCatalogProductsDto,
  ) {
    return this.catalogs.addProductsBulk(id, dto);
  }

  // Va ANTES de `:productId` a propósito: Nest resuelve por orden de
  // declaración, y con la ruta paramétrica arriba "reorder" entraría como si
  // fuera un id de producto.
  @Patch(':id/products/reorder')
  @ApiOperation({ summary: 'Reordenar productos (lista completa)' })
  reorderProducts(
    @Param('id') id: string,
    @Body() dto: ReorderCatalogProductsDto,
  ) {
    return this.catalogs.reorderProducts(id, dto);
  }

  @Patch(':id/products/:productId')
  @ApiOperation({ summary: 'Editar producto (precio incluido)' })
  updateProduct(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Body() dto: UpdateCatalogProductDto,
  ) {
    return this.catalogs.updateProduct(id, productId, dto);
  }

  @Delete(':id/products/:productId')
  @ApiOperation({ summary: 'Borrar producto y sus imágenes del bucket' })
  removeProduct(
    @Param('id') id: string,
    @Param('productId') productId: string,
  ) {
    return this.catalogs.removeProduct(id, productId);
  }

  // ─── Imágenes ──────────────────────────────────────────────────────────────

  @Post(':id/products/:productId/images')
  @ApiOperation({ summary: 'Subir foto (se convierte a WebP)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  // Mismo tope que el resto de subidas del producto: 5 MB de entrada. `sharp`
  // se encarga de que lo que quede guardado pese una fracción de eso.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5_242_880 } }))
  addImage(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @UploadedFile() file: unknown,
  ) {
    return this.catalogs.addProductMedia(
      id,
      productId,
      file as UploadedImageFile,
      'IMAGE',
    );
  }

  @Post(':id/products/:productId/videos')
  @ApiOperation({
    summary: `Subir video (MP4/WebM/MOV, máx. ${MAX_VIDEO_MB} MB, sin recomprimir)`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  // El tope de multer va 1 MB por encima del límite real para que un archivo
  // apenas pasado llegue entero y el servicio pueda responder "pesa más de 20
  // MB" en vez del error genérico de archivo truncado.
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: (MAX_VIDEO_MB + 1) * 1024 * 1024 },
    }),
  )
  addVideo(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @UploadedFile() file: unknown,
  ) {
    return this.catalogs.addProductMedia(
      id,
      productId,
      file as UploadedImageFile,
      'VIDEO',
    );
  }

  @Patch(':id/products/:productId/media/reorder')
  @ApiOperation({
    summary: 'Reordenar fotos y videos. El primero es la portada.',
  })
  reorderMedia(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Body() dto: ReorderCatalogImagesDto,
  ) {
    return this.catalogs.reorderProductMedia(id, productId, dto);
  }

  @Delete(':id/media/:mediaId')
  @ApiOperation({ summary: 'Borrar foto o video (fila y archivo del bucket)' })
  removeMedia(@Param('id') id: string, @Param('mediaId') mediaId: string) {
    return this.catalogs.removeProductMedia(id, mediaId);
  }
}
