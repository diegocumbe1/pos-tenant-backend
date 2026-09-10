import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import {
  CreateBarberServiceDto,
  UpdateBarberServiceDto,
} from './dto/barber-service.dto';

type ServiceWithAssets = Prisma.BarberServiceGetPayload<{
  include: {
    assets: true;
  };
}>;

@Injectable()
export class BarberServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
  ) {}

  async listServices(ctx: TenantContext) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    const services = await this.prisma.barberService.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        assets: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    return services.map((service) => this.toServiceDto(service));
  }

  async createService(ctx: TenantContext, dto: CreateBarberServiceDto) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    const created = await this.prisma.barberService.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name: dto.name,
        description: dto.description,
        durationMin: dto.durationMin,
        priceCOP: dto.priceCOP,
        costCOP: dto.costCOP ?? 0,
        durationOptions: (dto.durationOptions ??
          []) as unknown as Prisma.InputJsonValue,
        color: dto.color,
        imageUrls: dto.imageUrls ?? [],
        category: dto.category,
        resultDuration: dto.resultDuration,
        retouchPriceCOP: dto.retouchPriceCOP,
        retouchNote: dto.retouchNote,
        retouchAfterDays: dto.retouchAfterDays,
        maintenanceAfterDays: dto.maintenanceAfterDays,
        primaryImageUrl: dto.primaryImageUrl,
        sortOrder: dto.sortOrder,
      },
      include: {
        assets: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    return this.toServiceDto(created);
  }

  async updateService(
    ctx: TenantContext,
    id: string,
    dto: UpdateBarberServiceDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'barberService',
      ctx,
      id,
      'Service',
    );
    const updated = await this.prisma.barberService.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        durationMin: dto.durationMin,
        priceCOP: dto.priceCOP,
        costCOP: dto.costCOP,
        durationOptions:
          dto.durationOptions === undefined
            ? undefined
            : (dto.durationOptions as unknown as Prisma.InputJsonValue),
        color: dto.color,
        imageUrls: dto.imageUrls,
        category: dto.category,
        resultDuration: dto.resultDuration,
        retouchPriceCOP: dto.retouchPriceCOP,
        retouchNote: dto.retouchNote,
        retouchAfterDays: dto.retouchAfterDays,
        maintenanceAfterDays: dto.maintenanceAfterDays,
        primaryImageUrl: dto.primaryImageUrl,
        isActive: dto.isActive,
        sortOrder: dto.sortOrder,
      },
      include: {
        assets: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    return this.toServiceDto(updated);
  }

  async deleteService(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord(
      'barberService',
      ctx,
      id,
      'Service',
    );
    await this.prisma.barberService.update({
      where: { id },
      data: { isActive: false },
    });
    return { ok: true };
  }

  private toServiceDto(service: ServiceWithAssets) {
    return {
      id: service.id,
      tenantId: service.tenantId,
      branchId: service.branchId,
      name: service.name,
      description: service.description,
      durationMin: service.durationMin,
      priceCOP: service.priceCOP,
      costCOP: service.costCOP,
      durationOptions: this.coerceDurationOptions(service.durationOptions),
      color: service.color,
      imageUrls: service.imageUrls,
      category: service.category,
      resultDuration: service.resultDuration,
      retouchPriceCOP: service.retouchPriceCOP,
      retouchNote: service.retouchNote,
      retouchAfterDays: service.retouchAfterDays,
      maintenanceAfterDays: service.maintenanceAfterDays,
      primaryImageUrl: service.primaryImageUrl,
      isActive: service.isActive,
      sortOrder: service.sortOrder,
      createdAt: service.createdAt,
      updatedAt: service.updatedAt,
      assets: service.assets.map((asset) => ({
        id: asset.id,
        url: asset.url,
        alt: asset.alt,
        kind: asset.kind,
        fit: asset.fit,
        focalPoint: asset.focalPoint,
        showInPublicGallery: asset.showInPublicGallery,
        sortOrder: asset.sortOrder,
        createdAt: asset.createdAt,
      })),
    };
  }

  // Normaliza el JSON de bloques de duración: solo {minutes>0, priceCOP?}.
  private coerceDurationOptions(
    raw: Prisma.JsonValue,
  ): Array<{ minutes: number; priceCOP: number | null }> {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (entry): entry is { minutes: number; priceCOP?: number } =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as Record<string, unknown>).minutes === 'number' &&
          (entry as { minutes: number }).minutes > 0,
      )
      .map((entry) => ({
        minutes: entry.minutes,
        priceCOP:
          typeof entry.priceCOP === 'number' && entry.priceCOP >= 0
            ? entry.priceCOP
            : null,
      }));
  }
}
