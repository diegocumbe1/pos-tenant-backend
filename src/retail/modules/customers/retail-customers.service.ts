import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import {
  CreateRetailCustomerDto,
  UpdateRetailCustomerDto,
} from './dto/retail-customer.dto';

/**
 * Cómo llega un campo de texto opcional en un PATCH:
 *
 *   undefined → no se manda: se deja como estaba.
 *   ''        → se manda vacío: se BORRA, y se guarda NULL.
 *   valor     → se guarda.
 *
 * La cadena vacía tiene que borrar de verdad. Sin esto no había forma de quitar
 * un teléfono mal digitado —mandarlo vacío lo dejaba igual— y la única salida
 * era borrar al cliente y crearlo de nuevo, perdiendo su historial de compras.
 *
 * Y borra a NULL, no a '': un teléfono guardado como cadena vacía existe pero no
 * sirve, y toda pantalla que hace `phone ?? '—'` mostraría un hueco en vez de un
 * guion. "No tengo el dato" en base de datos se escribe NULL.
 */
function patchText(
  value: string | undefined,
  normalize: (value: string) => string = (raw) => raw,
): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? null : normalize(trimmed);
}

@Injectable()
export class RetailCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
  ) {}

  async listCustomers(ctx: TenantContext, search?: string) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    return this.prisma.retailCustomer.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search } },
                { documentId: { contains: search } },
              ],
            }
          : {}),
      },
      orderBy: [{ lastPurchaseAt: 'desc' }, { name: 'asc' }],
      take: 200,
    });
  }

  async createCustomer(ctx: TenantContext, dto: CreateRetailCustomerDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    try {
      return await this.prisma.retailCustomer.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          name: dto.name.trim(),
          phone: dto.phone?.replace(/\s/g, '') || null,
          email: dto.email,
          documentId: dto.documentId,
          notes: dto.notes,
        },
      });
    } catch (error) {
      throw this.mapUniqueError(error, dto.phone);
    }
  }

  async updateCustomer(
    ctx: TenantContext,
    id: string,
    dto: UpdateRetailCustomerDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'retailCustomer',
      ctx,
      id,
      'Customer',
    );
    try {
      return await this.prisma.retailCustomer.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          phone: patchText(dto.phone, (value) => value.replace(/\s/g, '')),
          email: patchText(dto.email),
          documentId: patchText(dto.documentId),
          notes: patchText(dto.notes),
        },
      });
    } catch (error) {
      throw this.mapUniqueError(error, dto.phone);
    }
  }

  async deleteCustomer(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord(
      'retailCustomer',
      ctx,
      id,
      'Customer',
    );
    await this.prisma.retailCustomer.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  /** Historial de compras de un cliente (ficha). */
  async getCustomerSales(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord(
      'retailCustomer',
      ctx,
      id,
      'Customer',
    );
    return this.prisma.retailSale.findMany({
      where: { customerId: id, tenantId: ctx.tenantId },
      orderBy: { soldAt: 'desc' },
      take: 100,
      include: { items: true },
    });
  }

  private mapUniqueError(error: unknown, phone?: string): Error {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(
        `Ya existe un cliente con el teléfono ${phone ?? ''}`.trim(),
      );
    }
    return error as Error;
  }
}
