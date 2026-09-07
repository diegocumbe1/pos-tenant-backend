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
import { UploadedImageFile } from '../assets/image-upload.service';
import { CatalogService } from './catalog.service';
import {
  BulkCatalogProductsDto,
  CreateCatalogDto,
  CreateCatalogProductDto,
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
  constructor(private readonly catalogs: CatalogService) {}

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
    return this.catalogs.addProductImage(
      id,
      productId,
      file as UploadedImageFile,
    );
  }

  @Patch(':id/products/:productId/images/reorder')
  @ApiOperation({ summary: 'Reordenar fotos. La primera es la portada.' })
  reorderImages(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Body() dto: ReorderCatalogImagesDto,
  ) {
    return this.catalogs.reorderProductImages(id, productId, dto);
  }

  @Delete(':id/images/:imageId')
  @ApiOperation({ summary: 'Borrar una foto (fila y archivo del bucket)' })
  removeImage(@Param('id') id: string, @Param('imageId') imageId: string) {
    return this.catalogs.removeProductImage(id, imageId);
  }
}
