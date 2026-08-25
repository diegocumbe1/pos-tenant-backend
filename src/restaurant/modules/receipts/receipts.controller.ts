import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { ReceiptsService } from './receipts.service';
import { ShareReceiptDto } from './dto/share-receipt.dto';

@ApiTags('Receipts')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
@Controller('restaurant/receipts')
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  @Post('share')
  @HttpCode(HttpStatus.CREATED)
  share(@CurrentTenant() ctx: TenantContext, @Body() dto: ShareReceiptDto) {
    return this.receiptsService.share(ctx, dto.orderId, dto.splitId, dto.payload);
  }
}

/**
 * Alias sin vertical: `POST /receipts/share`.
 *
 * El recibo compartible no es del restaurante — retail (y mañana barbería) lo
 * necesitan igual. La ruta neutra existe para que una venta de mostrador no
 * tenga que llamarse a sí misma "orden de restaurante"; el servicio es el mismo
 * y `orderId` es el id de la venta.
 */
@ApiTags('Receipts')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
@Controller('receipts')
export class SharedReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  @Post('share')
  @HttpCode(HttpStatus.CREATED)
  share(@CurrentTenant() ctx: TenantContext, @Body() dto: ShareReceiptDto) {
    return this.receiptsService.share(ctx, dto.orderId, dto.splitId, dto.payload);
  }
}

/** Página pública sin auth: `GET /public/receipts/:token`. */
@ApiTags('Receipts (public)')
@Controller('public/receipts')
export class PublicReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  @Get(':token')
  get(@Param('token') token: string) {
    return this.receiptsService.getPublic(token);
  }
}
