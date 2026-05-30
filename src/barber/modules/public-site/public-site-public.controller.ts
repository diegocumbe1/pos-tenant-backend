import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PublicSiteService } from './barber-public-site.service';

/**
 * Vertical-agnostic public read endpoint for a published site, consumed by the
 * brochure renderer (e.g. lynko.site/<slug>). Works for any vertical that has a
 * registered public-site strategy.
 */
@ApiTags('PublicSite')
@Controller('public/sites')
export class PublicSitePublicController {
  constructor(private readonly publicSiteService: PublicSiteService) {}

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
