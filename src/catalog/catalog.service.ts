import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CatalogStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  ImageUploadService,
  UploadedImageFile,
} from '../assets/image-upload.service';
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

/** Todo lo que necesita la página pública en una sola respuesta. */
const CATALOG_INCLUDE = {
  products: {
    orderBy: { sortOrder: 'asc' as const },
    include: { images: { orderBy: { sortOrder: 'asc' as const } } },
  },
} satisfies Prisma.CatalogInclude;

type CatalogWithProducts = Prisma.CatalogGetPayload<{
  include: typeof CATALOG_INCLUDE;
}>;

/**
 * Más de seis fotos no se navegan y solo pesan en datos móviles, que es la
 * conexión real de quien abre el catálogo desde un estado de WhatsApp.
 */
const MAX_IMAGES_PER_PRODUCT = 6;

/**
 * Catálogos gestionados: el servicio de temporada para vendedores SIN cuenta.
 *
 * QUIÉN LO EDITA. Solo el superadmin. El dueño del catálogo nunca entra —si
 * pudiera entrar a editar ya sería un tenant, y entonces debería estar pagando
 * Retail—. Por eso no hay `TenantContext` en ninguna firma de este servicio: no
 * hay tenant al que pertenezca.
 *
 * QUÉ NO HACE, Y POR QUÉ. Sin existencias, sin pagos, sin cuentas. No es una
 * limitación pendiente de resolver: es el límite que hace que el catálogo se
 * pueda vender barato y que, cuando al cliente empiece a dolerle el inventario,
 * la respuesta sea Retail. Ver docs/CATALOGOS_GESTIONADOS_PLAN.md.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly imageUpload: ImageUploadService,
    private readonly supabase: SupabaseService,
  ) {}

  // ─── Lectura pública ───────────────────────────────────────────────────────

  /**
   * El catálogo tal como lo ve cualquiera que abra el link.
   *
   * Solo PUBLISHED. Un borrador que responde 200 se indexa en Google y se
   * comparte por error; 404 es la única respuesta segura.
   *
   * Se lee la tabla EN VIVO, sin snapshot publicado. `PublicSite` congela un
   * `publishedPayload` porque un sitio se edita mucho antes de publicarse; acá
   * lo edita una sola persona cambiando un precio a la carrera, y un paso extra
   * de "publicar" se olvida — el cliente llama diciendo que el precio no cambió.
   */
  async getPublicBySlug(slug: string) {
    const catalog = await this.prisma.catalog.findFirst({
      where: { slug, status: CatalogStatus.PUBLISHED },
      include: CATALOG_INCLUDE,
    });
    if (!catalog) throw new NotFoundException('Catálogo no encontrado');
    return this.toPublicDto(catalog);
  }

  // ─── Backoffice ────────────────────────────────────────────────────────────

  async list(query: ListCatalogsQueryDto) {
    const search = query.search?.trim();
    const catalogs = await this.prisma.catalog.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(search
          ? {
              OR: [
                { businessName: { contains: search, mode: 'insensitive' } },
                { slug: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { products: true } } },
    });
    return catalogs.map((catalog) => ({
      id: catalog.id,
      slug: catalog.slug,
      status: catalog.status,
      businessName: catalog.businessName,
      season: catalog.season,
      city: catalog.city,
      whatsapp: catalog.whatsapp,
      contactName: catalog.contactName,
      expiresAt: catalog.expiresAt,
      convertedTenantId: catalog.convertedTenantId,
      productsCount: catalog._count.products,
      publishedAt: catalog.publishedAt,
      updatedAt: catalog.updatedAt,
    }));
  }

  async get(id: string) {
    const catalog = await this.prisma.catalog.findUnique({
      where: { id },
      include: CATALOG_INCLUDE,
    });
    if (!catalog) throw new NotFoundException('Catálogo no encontrado');
    return this.toAdminDto(catalog);
  }

  async create(dto: CreateCatalogDto) {
    const slug = await this.resolveSlug(dto.slug ?? dto.businessName, null);
    const catalog = await this.prisma.catalog.create({
      data: {
        slug,
        businessName: dto.businessName,
        whatsapp: dto.whatsapp,
        ...this.detailsData(dto),
      },
      include: CATALOG_INCLUDE,
    });
    return this.toAdminDto(catalog);
  }

  async update(id: string, dto: UpdateCatalogDto) {
    const existing = await this.assertCatalog(id);

    // El slug es la URL que el cliente ya repartió por WhatsApp y pegó en un QR.
    // Cambiarlo después de publicar mata todos esos links, y quien lo cambia no
    // es quien recibe las quejas. Se despublica primero, a mano y a propósito.
    if (dto.slug && dto.slug !== existing.slug) {
      if (existing.status === CatalogStatus.PUBLISHED) {
        throw new BadRequestException(
          'No se puede cambiar el link de un catálogo publicado: los QR y los ' +
            'mensajes que ya se repartieron dejarían de funcionar. Despublícalo ' +
            'primero si de verdad hay que cambiarlo.',
        );
      }
      await this.assertSlugFree(dto.slug, id);
    }

    const catalog = await this.prisma.catalog.update({
      where: { id },
      data: {
        ...(dto.slug ? { slug: dto.slug } : {}),
        ...this.detailsData(dto),
      },
      include: CATALOG_INCLUDE,
    });
    return this.toAdminDto(catalog);
  }

  /**
   * Publicar exige lo mínimo para que el link sirva: al menos un producto y un
   * WhatsApp. Un catálogo vacío en línea es peor que uno sin publicar — el
   * cliente lo comparte y queda mal.
   */
  async publish(id: string, actorUserId: string) {
    const catalog = await this.prisma.catalog.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });
    if (!catalog) throw new NotFoundException('Catálogo no encontrado');
    if (catalog._count.products === 0) {
      throw new BadRequestException(
        'El catálogo no tiene productos. Cárgale al menos uno antes de publicarlo.',
      );
    }

    const updated = await this.prisma.catalog.update({
      where: { id },
      data: {
        status: CatalogStatus.PUBLISHED,
        publishedAt: catalog.publishedAt ?? new Date(),
        publishedByUserId: actorUserId,
      },
      include: CATALOG_INCLUDE,
    });
    return this.toAdminDto(updated);
  }

  async unpublish(id: string) {
    await this.assertCatalog(id);
    const catalog = await this.prisma.catalog.update({
      where: { id },
      data: { status: CatalogStatus.DRAFT },
      include: CATALOG_INCLUDE,
    });
    return this.toAdminDto(catalog);
  }

  /** Temporada cerrada: deja de listarse como activo pero el link sigue vivo. */
  async archive(id: string) {
    await this.assertCatalog(id);
    const catalog = await this.prisma.catalog.update({
      where: { id },
      data: { status: CatalogStatus.ARCHIVED },
      include: CATALOG_INCLUDE,
    });
    return this.toAdminDto(catalog);
  }

  /**
   * Borra el catálogo entero.
   *
   * PRIMERO EL BUCKET, DESPUÉS LAS FILAS. Al revés se pierde el `path` de cada
   * imagen y los archivos quedan huérfanos en Supabase, ocupando y cobrando
   * para siempre sin que nadie sepa de dónde salieron.
   */
  async remove(id: string) {
    const catalog = await this.prisma.catalog.findUnique({
      where: { id },
      include: { products: { include: { images: true } } },
    });
    if (!catalog) throw new NotFoundException('Catálogo no encontrado');

    const paths = catalog.products.flatMap((product) =>
      product.images.map((image) => image.path),
    );
    await this.deleteFromBucket(paths);

    await this.prisma.catalog.delete({ where: { id } });
    return { id, deleted: true, imagesRemoved: paths.length };
  }

  // ─── Productos ─────────────────────────────────────────────────────────────

  async addProduct(catalogId: string, dto: CreateCatalogProductDto) {
    await this.assertCatalog(catalogId);
    const last = await this.prisma.catalogProduct.findFirst({
      where: { catalogId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const product = await this.prisma.catalogProduct.create({
      data: {
        catalogId,
        name: dto.name,
        priceCOP: dto.priceCOP,
        description: dto.description ?? null,
        category: dto.category ?? null,
        wholesalePrice6COP: dto.wholesalePrice6COP ?? null,
        isAvailable: dto.isAvailable ?? true,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
    return product;
  }

  /** Carga inicial de un catálogo entero, en el orden en que vienen. */
  async addProductsBulk(catalogId: string, dto: BulkCatalogProductsDto) {
    await this.assertCatalog(catalogId);
    const last = await this.prisma.catalogProduct.findFirst({
      where: { catalogId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    let sortOrder = (last?.sortOrder ?? -1) + 1;

    await this.prisma.catalogProduct.createMany({
      data: dto.products.map((product) => ({
        catalogId,
        name: product.name,
        priceCOP: product.priceCOP,
        description: product.description ?? null,
        category: product.category ?? null,
        wholesalePrice6COP: product.wholesalePrice6COP ?? null,
        isAvailable: product.isAvailable ?? true,
        sortOrder: sortOrder++,
      })),
    });
    return this.get(catalogId);
  }

  async updateProduct(
    catalogId: string,
    productId: string,
    dto: UpdateCatalogProductDto,
  ) {
    await this.assertProduct(catalogId, productId);
    return this.prisma.catalogProduct.update({
      where: { id: productId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.priceCOP !== undefined ? { priceCOP: dto.priceCOP } : {}),
        ...(dto.wholesalePrice6COP !== undefined
          ? { wholesalePrice6COP: dto.wholesalePrice6COP }
          : {}),
        ...(dto.isAvailable !== undefined
          ? { isAvailable: dto.isAvailable }
          : {}),
      },
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  async removeProduct(catalogId: string, productId: string) {
    const product = await this.assertProduct(catalogId, productId);
    await this.deleteFromBucket(product.images.map((image) => image.path));
    await this.prisma.catalogProduct.delete({ where: { id: productId } });
    return { id: productId, deleted: true };
  }

  async reorderProducts(catalogId: string, dto: ReorderCatalogProductsDto) {
    const products = await this.prisma.catalogProduct.findMany({
      where: { catalogId },
      select: { id: true },
    });
    const known = new Set(products.map((product) => product.id));
    // Se exige la lista COMPLETA: un reordenamiento parcial deja los que no
    // vinieron con un `sortOrder` que ya no significa nada respecto al resto.
    if (
      dto.productIds.length !== known.size ||
      dto.productIds.some((id) => !known.has(id))
    ) {
      throw new BadRequestException(
        'El orden tiene que traer exactamente los productos de este catálogo.',
      );
    }

    await this.prisma.$transaction(
      dto.productIds.map((id, index) =>
        this.prisma.catalogProduct.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );
    return this.get(catalogId);
  }

  // ─── Imágenes ──────────────────────────────────────────────────────────────

  /**
   * Sube una foto de producto: la valida, la convierte a WebP y la deja en
   * Supabase Storage.
   *
   * VA DIRECTO A `ImageUploadService`, NO a `AssetsService`. Ese arma la ruta
   * del bucket a partir de `ctx.tenantId` y un catálogo no tiene tenant: por eso
   * la ruta se construye acá, con el id del catálogo como raíz.
   */
  async addProductImage(
    catalogId: string,
    productId: string,
    file: UploadedImageFile,
  ) {
    const product = await this.assertProduct(catalogId, productId);
    if (product.images.length >= MAX_IMAGES_PER_PRODUCT) {
      throw new BadRequestException(
        `Máximo ${MAX_IMAGES_PER_PRODUCT} fotos por producto. Borra alguna antes de subir otra.`,
      );
    }

    const uploaded = await this.imageUpload.uploadImage({
      file,
      pathPrefix: `catalogs/${catalogId}/products/${productId}`,
      kind: 'gallery',
    });

    const image = await this.prisma.catalogProductImage.create({
      data: {
        productId,
        url: uploaded.publicUrl,
        path: uploaded.path,
        sortOrder: product.images.length,
      },
    });

    // La portada del primer producto alimenta la previsualización de WhatsApp,
    // que es lo que se ve cuando alguien pega el link. Sin `ogImageUrl` el link
    // sale como texto pelado y la mitad de la gracia se pierde.
    await this.backfillOgImage(catalogId, uploaded.publicUrl);

    return image;
  }

  async removeProductImage(catalogId: string, imageId: string) {
    const image = await this.prisma.catalogProductImage.findFirst({
      where: { id: imageId, product: { catalogId } },
    });
    if (!image) throw new NotFoundException('Imagen no encontrada');

    await this.deleteFromBucket([image.path]);
    await this.prisma.catalogProductImage.delete({ where: { id: imageId } });
    return { id: imageId, deleted: true };
  }

  async reorderProductImages(
    catalogId: string,
    productId: string,
    dto: ReorderCatalogImagesDto,
  ) {
    const product = await this.assertProduct(catalogId, productId);
    const known = new Set(product.images.map((image) => image.id));
    if (
      dto.imageIds.length !== known.size ||
      dto.imageIds.some((id) => !known.has(id))
    ) {
      throw new BadRequestException(
        'El orden tiene que traer exactamente las fotos de este producto.',
      );
    }

    await this.prisma.$transaction(
      dto.imageIds.map((id, index) =>
        this.prisma.catalogProductImage.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );
    return this.prisma.catalogProduct.findUnique({
      where: { id: productId },
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  // ─── Internos ──────────────────────────────────────────────────────────────

  private async assertCatalog(id: string) {
    const catalog = await this.prisma.catalog.findUnique({ where: { id } });
    if (!catalog) throw new NotFoundException('Catálogo no encontrado');
    return catalog;
  }

  /** El producto tiene que ser DE ESTE catálogo: la ruta no basta como prueba. */
  private async assertProduct(catalogId: string, productId: string) {
    const product = await this.prisma.catalogProduct.findFirst({
      where: { id: productId, catalogId },
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!product) throw new NotFoundException('Producto no encontrado');
    return product;
  }

  private detailsData(dto: Partial<CreateCatalogDto>) {
    return {
      ...(dto.businessName !== undefined
        ? { businessName: dto.businessName }
        : {}),
      ...(dto.season !== undefined ? { season: dto.season } : {}),
      ...(dto.city !== undefined ? { city: dto.city } : {}),
      ...(dto.intro !== undefined ? { intro: dto.intro } : {}),
      ...(dto.whatsapp !== undefined ? { whatsapp: dto.whatsapp } : {}),
      ...(dto.themePrimary !== undefined
        ? { themePrimary: dto.themePrimary }
        : {}),
      ...(dto.themeAccent !== undefined
        ? { themeAccent: dto.themeAccent }
        : {}),
      ...(dto.themeMode !== undefined ? { themeMode: dto.themeMode } : {}),
      ...(dto.seoTitle !== undefined ? { seoTitle: dto.seoTitle } : {}),
      ...(dto.seoDescription !== undefined
        ? { seoDescription: dto.seoDescription }
        : {}),
      ...(dto.ogImageUrl !== undefined ? { ogImageUrl: dto.ogImageUrl } : {}),
      ...(dto.contactName !== undefined
        ? { contactName: dto.contactName }
        : {}),
      ...(dto.contactNote !== undefined
        ? { contactNote: dto.contactNote }
        : {}),
      ...(dto.expiresAt !== undefined
        ? { expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null }
        : {}),
    };
  }

  /** "Detalles con Amor" → "detalles-con-amor", con sufijo si ya existe. */
  private async resolveSlug(source: string, excludeId: string | null) {
    const base =
      source
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || 'catalogo';

    let candidate = base;
    let suffix = 2;
    while (await this.slugTaken(candidate, excludeId)) {
      candidate = `${base}-${suffix++}`;
    }
    return candidate;
  }

  private async slugTaken(slug: string, excludeId: string | null) {
    const found = await this.prisma.catalog.findUnique({
      where: { slug },
      select: { id: true },
    });
    return Boolean(found && found.id !== excludeId);
  }

  private async assertSlugFree(slug: string, excludeId: string | null) {
    if (await this.slugTaken(slug, excludeId)) {
      throw new BadRequestException(`El link "${slug}" ya está usado.`);
    }
  }

  /** Primera foto que entra = previsualización del link, si no había una. */
  private async backfillOgImage(catalogId: string, url: string) {
    await this.prisma.catalog.updateMany({
      where: { id: catalogId, ogImageUrl: null },
      data: { ogImageUrl: url },
    });
  }

  /**
   * Borra del bucket sin tumbar la operación.
   *
   * Si Supabase falla, la fila igual se borra: dejar el producto vivo porque no
   * se pudo limpiar un archivo sería castigar al usuario por un problema de
   * infraestructura. Queda el log para poder barrer después.
   */
  private async deleteFromBucket(paths: string[]) {
    for (const path of paths) {
      try {
        await this.supabase.deletePublicAsset(path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`No se pudo borrar del bucket ${path}: ${msg}`);
      }
    }
  }

  private toAdminDto(catalog: CatalogWithProducts) {
    return {
      ...this.toPublicDto(catalog),
      // Las fotos van COMPLETAS, no solo la URL como en la respuesta pública:
      // el editor necesita el id de cada una para poder borrarla y reordenarla.
      // `path` no viaja —es la ruta interna del bucket, y el frontend no tiene
      // nada que hacer con ella—.
      products: catalog.products.map((product) => ({
        id: product.id,
        name: product.name,
        description: product.description,
        category: product.category,
        priceCOP: product.priceCOP,
        wholesalePrice6COP: product.wholesalePrice6COP,
        isAvailable: product.isAvailable,
        sortOrder: product.sortOrder,
        images: product.images.map((image) => ({
          id: image.id,
          url: image.url,
          sortOrder: image.sortOrder,
        })),
      })),
      status: catalog.status,
      contactName: catalog.contactName,
      contactNote: catalog.contactNote,
      expiresAt: catalog.expiresAt,
      convertedTenantId: catalog.convertedTenantId,
      publishedAt: catalog.publishedAt,
      createdAt: catalog.createdAt,
      updatedAt: catalog.updatedAt,
    };
  }

  /**
   * Lo que ve el público. NO lleva los datos comerciales —a quién se le cobra,
   * cuándo renueva— porque eso es de la plataforma, no del catálogo, y viaja en
   * un JSON que cualquiera puede leer.
   */
  private toPublicDto(catalog: CatalogWithProducts) {
    return {
      id: catalog.id,
      slug: catalog.slug,
      businessName: catalog.businessName,
      season: catalog.season,
      city: catalog.city,
      intro: catalog.intro,
      whatsapp: catalog.whatsapp,
      theme: {
        primary: catalog.themePrimary,
        accent: catalog.themeAccent,
        mode: catalog.themeMode,
      },
      seoTitle: catalog.seoTitle,
      seoDescription: catalog.seoDescription,
      ogImageUrl: catalog.ogImageUrl,
      products: catalog.products.map((product) => ({
        id: product.id,
        name: product.name,
        description: product.description,
        category: product.category,
        priceCOP: product.priceCOP,
        wholesalePrice6COP: product.wholesalePrice6COP,
        isAvailable: product.isAvailable,
        images: product.images.map((image) => image.url),
      })),
      /** Categorías en el orden en que aparecen: es el orden que puso el admin. */
      categories: [
        ...new Set(
          catalog.products
            .map((product) => product.category)
            .filter((category): category is string => Boolean(category)),
        ),
      ],
    };
  }
}
