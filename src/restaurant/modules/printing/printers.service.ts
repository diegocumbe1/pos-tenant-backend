import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { CreatePrinterDto, UpdatePrinterDto } from './dto/printer.dto';

@Injectable()
export class PrintersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(ctx: TenantContext) {
    const printers = await this.prisma.printer.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      orderBy: { createdAt: 'asc' },
    });
    return { printers };
  }

  async create(ctx: TenantContext, dto: CreatePrinterDto) {
    return this.prisma.printer.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name: dto.name,
        target: dto.target,
        connection: dto.connection,
        address: dto.address,
        paperWidth: dto.paperWidth ?? 80,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async update(ctx: TenantContext, id: string, dto: UpdatePrinterDto) {
    await this.assertPrinter(ctx, id);
    return this.prisma.printer.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.target !== undefined ? { target: dto.target } : {}),
        ...(dto.connection !== undefined ? { connection: dto.connection } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.paperWidth !== undefined ? { paperWidth: dto.paperWidth } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  async remove(ctx: TenantContext, id: string) {
    await this.assertPrinter(ctx, id);
    await this.prisma.printer.delete({ where: { id } });
    return { id, deleted: true };
  }

  private async assertPrinter(ctx: TenantContext, id: string) {
    const printer = await this.prisma.printer.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
    if (!printer) throw new NotFoundException(`Printer ${id} not found`);
    return printer;
  }
}
