import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { performance } from 'perf_hooks';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

type TimedRequest = Request & { requestTimings?: Record<string, number> };

@ApiTags('Products')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('restaurant/products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  async findAll(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: TimedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const timings = req.requestTimings ?? {};
    const serviceStart = performance.now();
    const response = await this.productsService.findAll(ctx);
    timings.service = performance.now() - serviceStart;
    timings.total = Object.values(timings).reduce((sum, value) => sum + value, 0);

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Server-Timing', this.toServerTimingHeader(timings));
    return response;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateProductDto,
  ) {
    return this.productsService.create(ctx, dto);
  }

  @Patch(':id')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.productsService.update(ctx, id, dto);
  }

  @Get(':id/price-history')
  priceHistory(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.productsService.priceHistory(ctx, id);
  }

  @Patch(':id/toggle')
  toggle(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.productsService.toggle(ctx, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.productsService.remove(ctx, id);
  }

  private toServerTimingHeader(timings: Record<string, number>) {
    return Object.entries(timings)
      .map(([key, value]) => `${key};dur=${value.toFixed(1)}`)
      .join(', ');
  }
}
