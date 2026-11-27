import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordSetGuard } from './guards/password-set.guard';
import { ActivationRequestService } from './services/activation-request.service';
import { AuthenticatedUser } from './types/tenant-context.interface';

/**
 * Solicitudes del cliente al super-admin desde la app. Sin `TenantGuard` a
 * propósito: el negocio a activar está bloqueado, y la regla de acceso
 * (`resolveTenantAccess`) se aplica dentro del servicio.
 */
@ApiTags('Auth')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PasswordSetGuard)
@Controller('auth/businesses')
export class BusinessRequestsController {
  constructor(private readonly requests: ActivationRequestService) {}

  @Post(':tenantId/activation-request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Ask Lynko to activate a suspended/expired business from the switch',
  })
  requestActivation(@Req() req: Request, @Param('tenantId') tenantId: string) {
    return this.requests.requestActivation(
      req.user as AuthenticatedUser,
      tenantId,
    );
  }
}
