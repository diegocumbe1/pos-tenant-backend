import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../auth/guards/password-set.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequireAnyPermission } from '../auth/decorators/require-permissions.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { WhatsappTemplatesService } from './whatsapp-templates.service';
import { UpdateWhatsappTemplateDto } from './dto/update-template.dto';
import {
  WhatsappTemplateDefinition,
  isWhatsappTemplateKey,
} from './templates/message-templates';

/**
 * Edición de los textos de WhatsApp del negocio.
 *
 * Va aparte de `WhatsAppController` porque aquel resuelve el tenant desde
 * headers con fallback a los IDs de demo, y escribir configuración con ese
 * fallback terminaría guardando en el tenant equivocado. Aquí el tenant sale
 * del JWT, como en el resto de Ajustes.
 *
 * Los permisos son los de ajustes de cada vertical: el usuario solo tiene el
 * suyo, así que se exige cualquiera de los dos.
 */
@ApiTags('WhatsAppTemplates')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('whatsapp/templates')
export class WhatsappTemplatesController {
  constructor(private readonly templates: WhatsappTemplatesService) {}

  @Get()
  @RequireAnyPermission('barber:settings:read', 'retail:settings:read')
  list(@CurrentTenant() ctx: TenantContext, @Query('scope') scope?: string) {
    if (scope && scope !== 'agenda' && scope !== 'catalog') {
      throw new BadRequestException("scope debe ser 'agenda' o 'catalog'");
    }
    return this.templates.list(
      ctx.tenantId,
      scope as WhatsappTemplateDefinition['scope'] | undefined,
    );
  }

  @Put(':key')
  @RequireAnyPermission('barber:settings:write', 'retail:settings:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('key') key: string,
    @Body() dto: UpdateWhatsappTemplateDto,
  ) {
    if (!isWhatsappTemplateKey(key)) {
      throw new BadRequestException(`Plantilla desconocida: ${key}`);
    }
    if (dto.body === undefined && dto.enabled === undefined) {
      throw new BadRequestException('Nada que actualizar');
    }
    return this.templates.upsert(ctx.tenantId, key, dto, ctx.userId);
  }

  /** Restaura el default borrando la personalización. */
  @Delete(':key')
  @RequireAnyPermission('barber:settings:write', 'retail:settings:write')
  reset(@CurrentTenant() ctx: TenantContext, @Param('key') key: string) {
    if (!isWhatsappTemplateKey(key)) {
      throw new BadRequestException(`Plantilla desconocida: ${key}`);
    }
    return this.templates.reset(ctx.tenantId, key);
  }
}
