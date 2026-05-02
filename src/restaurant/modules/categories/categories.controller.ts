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
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

type TimedRequest = Request & { requestTimings?: Record<string, number> };

@ApiTags('Categories')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('restaurant/categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  async findAll(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: TimedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const timings = req.requestTimings ?? {};
    const serviceStart = performance.now();
    const response = await this.categoriesService.findAll(ctx);
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
    @Body() dto: CreateCategoryDto,
  ) {
    return this.categoriesService.create(ctx, dto);
  }

  @Patch(':id')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categoriesService.update(ctx, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.categoriesService.remove(ctx, id);
  }

  private toServerTimingHeader(timings: Record<string, number>) {
    return Object.entries(timings)
      .map(([key, value]) => `${key};dur=${value.toFixed(1)}`)
      .join(', ');
  }
}
