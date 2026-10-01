import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import { BarberAppointmentsService } from '../appointments/barber-appointments.service';
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
    private readonly appointments: BarberAppointmentsService,
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
    const category = await this.ensureCategory(ctx, dto.category);
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
        category,
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
    const category = await this.ensureCategory(ctx, dto.category);
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
        category,
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
    // Las citas referencian el servicio sin cascade: si tiene historial, borrarlo
    // rompería la agenda y las finanzas pasadas, así que solo se archiva. Sin
    // citas se borra de verdad (assets y asignaciones a staff caen por cascade).
    const appointments = await this.prisma.barberAppointment.count({
      where: { serviceId: id },
    });
    if (appointments > 0) {
      await this.prisma.barberService.update({
        where: { id },
        data: { isActive: false },
      });
      return { ok: true, deleted: false, archived: true, appointments };
    }
    await this.prisma.barberService.delete({ where: { id } });
    return { ok: true, deleted: true, archived: false, appointments: 0 };
  }

  // Las citas que impiden borrar el servicio, para que el admin decida con el
  // historial a la vista y no a ciegas.
  async listServiceAppointments(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord(
      'barberService',
      ctx,
      id,
      'Service',
    );
    const rows = await this.prisma.barberAppointment.findMany({
      where: { serviceId: id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        staff: { select: { id: true, name: true } },
      },
      orderBy: { scheduledAt: 'desc' },
    });
    return rows.map((a) => ({
      id: a.id,
      scheduledAt: a.scheduledAt,
      servedAt: a.servedAt,
      status: a.status,
      priceCOP: a.priceCOP,
      notes: a.notes,
      customer: a.customer,
      staff: a.staff,
    }));
  }

  /**
   * Borra el servicio CON sus citas. Es para limpiar pruebas o errores: se va
   * el ingreso de esas citas y sus eventos (cascade). Las visitas de cada
   * cliente afectado se recalculan para que no queden contadores fantasma.
   */
  async deleteServiceWithAppointments(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord(
      'barberService',
      ctx,
      id,
      'Service',
    );
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.barberAppointment.findMany({
        where: { serviceId: id },
        select: { customerId: true },
      });
      await tx.barberAppointment.deleteMany({ where: { serviceId: id } });
      for (const customerId of new Set(rows.map((r) => r.customerId))) {
        await this.appointments.syncCustomerVisits(tx, customerId);
      }
      await tx.barberService.delete({ where: { id } });
      return {
        ok: true,
        deleted: true,
        archived: false,
        appointments: rows.length,
      };
    });
  }

  /**
   * Copia el servicio para editarlo como otro (p. ej. la versión para hombres).
   * Las fotos se copian como filas apuntando al MISMO archivo: borrar una foto
   * solo borra su fila, nunca el archivo del storage, así que compartirlo es
   * seguro. También hereda quién del staff lo presta. No copia citas.
   */
  async duplicateService(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord(
      'barberService',
      ctx,
      id,
      'Service',
    );
    const source = await this.prisma.barberService.findUniqueOrThrow({
      where: { id },
      include: { assets: true, staffServices: true },
    });
    const name = await this.nextCopyName(ctx, source.name);

    const created = await this.prisma.$transaction(async (tx) => {
      const copy = await tx.barberService.create({
        data: {
          tenantId: source.tenantId,
          branchId: source.branchId,
          name,
          description: source.description,
          durationMin: source.durationMin,
          priceCOP: source.priceCOP,
          costCOP: source.costCOP,
          durationOptions: source.durationOptions as Prisma.InputJsonValue,
          color: source.color,
          imageUrls: source.imageUrls,
          category: source.category,
          resultDuration: source.resultDuration,
          retouchPriceCOP: source.retouchPriceCOP,
          retouchNote: source.retouchNote,
          retouchAfterDays: source.retouchAfterDays,
          maintenanceAfterDays: source.maintenanceAfterDays,
          primaryImageUrl: source.primaryImageUrl,
          isActive: source.isActive,
          sortOrder: source.sortOrder,
        },
      });
      if (source.assets.length > 0) {
        await tx.barberServiceAsset.createMany({
          data: source.assets.map((asset) => ({
            tenantId: asset.tenantId,
            serviceId: copy.id,
            url: asset.url,
            alt: asset.alt,
            kind: asset.kind,
            fit: asset.fit,
            focalPoint: asset.focalPoint,
            showInPublicGallery: asset.showInPublicGallery,
            sortOrder: asset.sortOrder,
          })),
        });
      }
      if (source.staffServices.length > 0) {
        await tx.barberStaffService.createMany({
          data: source.staffServices.map((link) => ({
            staffId: link.staffId,
            serviceId: copy.id,
          })),
        });
      }
      return tx.barberService.findUniqueOrThrow({
        where: { id: copy.id },
        include: {
          assets: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
        },
      });
    });
    return this.toServiceDto(created);
  }

  // "Microblading" → "Microblading (copia)" → "Microblading (copia 2)"...
  // El nombre es único por sede.
  private async nextCopyName(ctx: TenantContext, base: string) {
    const taken = new Set(
      (
        await this.prisma.barberService.findMany({
          where: { branchId: ctx.branchId, name: { startsWith: base } },
          select: { name: true },
        })
      ).map((s) => s.name),
    );
    let candidate = `${base} (copia)`;
    for (let n = 2; taken.has(candidate); n++) {
      candidate = `${base} (copia ${n})`;
    }
    return candidate;
  }

  // Un servicio guardado con una categoría que no está en la lista la agrega:
  // la lista gestionada y el texto del servicio nunca se desincronizan.
  private async ensureCategory(
    ctx: TenantContext,
    category: string | undefined | null,
  ): Promise<string | null | undefined> {
    // undefined = no tocar; null o "" = sin categoría.
    if (category === undefined) return undefined;
    const name = category?.trim();
    if (!name) return null;
    const count = await this.prisma.barberServiceCategory.count({
      where: { branchId: ctx.branchId },
    });
    await this.prisma.barberServiceCategory.upsert({
      where: { branchId_name: { branchId: ctx.branchId, name } },
      create: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name,
        sortOrder: count,
      },
      update: {},
    });
    return name;
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
