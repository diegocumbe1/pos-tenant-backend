import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CatalogService } from './catalog.service';

/**
 * El catálogo tal como lo lee cualquiera que abra el link
 * (uselynko.com/c/<slug>).
 *
 * SIN GUARDS A PROPÓSITO: no hay sesión, no hay tenant, no hay nada que
 * autenticar. Es una página pública que se comparte por WhatsApp.
 *
 * El servicio solo devuelve catálogos PUBLISHED; un borrador responde 404, no
 * un 200 vacío. Un borrador que responde 200 se indexa en Google y se comparte
 * por error.
 */
@ApiTags('Catalogs')
@Controller('public/catalogs')
export class CatalogPublicController {
  constructor(private readonly catalogs: CatalogService) {}

  @Get(':slug')
  // Un minuto: suficiente para aguantar el pico de cuando el vendedor sube el
  // estado de WhatsApp, y corto para que corregir un precio equivocado se vea
  // casi de una. Los precios de temporada se corrigen en caliente.
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'Catálogo publicado, por slug' })
  getBySlug(@Param('slug') slug: string) {
    return this.catalogs.getPublicBySlug(slug);
  }
}
