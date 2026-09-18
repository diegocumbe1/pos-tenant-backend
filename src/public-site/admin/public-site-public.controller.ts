import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PublicSiteService } from './public-site.service';

/**
 * Vertical-agnostic public read endpoint for a published site, consumed by the
 * brochure renderer (e.g. lynko.site/<slug>). Works for any vertical that has a
 * registered public-site strategy.
 */
@ApiTags('PublicSite')
@Controller('public/sites')
export class PublicSitePublicController {
  constructor(private readonly publicSiteService: PublicSiteService) {}

  /**
   * Índice de sitios publicados, para el `sitemap.xml` y el directorio público.
   *
   * Va declarado ANTES de `:slug`: Nest resuelve las rutas en orden de
   * declaración y `/public/sites` no debe caer nunca en el handler del slug.
   *
   * Cache más larga que la del detalle porque cambia mucho menos: un sitio
   * entra o sale de esta lista solo al publicar o despublicar.
   */
  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  listSites() {
    return this.publicSiteService.listPublishedSites();
  }

  @Get(':slug')
  @Header('Cache-Control', 'public, max-age=60')
  getSite(@Param('slug') slug: string) {
    return this.publicSiteService.getPublicSiteBySlug(slug);
  }

  @Get(':slug/catalog')
  @Header('Cache-Control', 'public, max-age=60')
  getCatalog(@Param('slug') slug: string) {
    return this.publicSiteService.getPublicCatalogBySlug(slug);
  }

  @Get(':slug/services')
  @Header('Cache-Control', 'public, max-age=60')
  getServices(@Param('slug') slug: string) {
    return this.publicSiteService.getPublicServicesBySlug(slug);
  }
}
