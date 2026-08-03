import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import {
  CreateRetailCustomerDto,
  UpdateRetailCustomerDto,
} from './dto/retail-customer.dto';

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
          phone:
            dto.phone === undefined ? undefined : dto.phone.replace(/\s/g, ''),
          email: dto.email,
          documentId: dto.documentId,
          notes: dto.notes,
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
