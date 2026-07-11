import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { CreatePrinterDto, UpdatePrinterDto } from './dto/printer.dto';
import { PrintJobsService } from './print-jobs.service';
import { PrintDocument } from './printing.types';

@Injectable()
export class PrintersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly printJobs: PrintJobsService,
  ) {}

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
        ipAddress: dto.ipAddress,
        port: dto.port ?? (dto.connection === 'NETWORK' ? 9100 : null),
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
        ...(dto.ipAddress !== undefined ? { ipAddress: dto.ipAddress } : {}),
        ...(dto.port !== undefined ? { port: dto.port } : {}),
        ...(dto.paperWidth !== undefined ? { paperWidth: dto.paperWidth } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  /** Heartbeat del agente local: marca la impresora como alcanzable (o no). */
  async heartbeat(ctx: TenantContext, id: string, online: boolean) {
    await this.assertPrinter(ctx, id);
    return this.prisma.printer.update({
      where: { id },
      data: { lastSeenAt: online ? new Date() : null },
    });
  }

  /**
   * Encola un ticket de prueba para esa impresora. El agente local lo drena y lo
   * envía por TCP a la impresora; si es USB, el front lo imprime por WebUSB.
   */
  async testPrint(ctx: TenantContext, id: string) {
    const printer = await this.assertPrinter(ctx, id);
    const document: PrintDocument = {
      id: `TEST-${printer.id}-${Date.now()}`,
      type: 'KITCHEN_TICKET',
      printerTarget: printer.target,
      createdAt: new Date().toISOString(),
      blocks: [
        { kind: 'text', text: printer.name, align: 'center', bold: true, size: 'lg' },
        { kind: 'text', text: 'PRUEBA DE IMPRESION', align: 'center', size: 'sm' },
        { kind: 'line' },
        { kind: 'row', left: 'Destino', right: printer.target },
        { kind: 'row', left: 'Conexion', right: printer.connection },
        {
          kind: 'row',
          left: 'Direccion',
          right: printer.ipAddress
            ? `${printer.ipAddress}:${printer.port ?? 9100}`
            : (printer.address ?? 'USB'),
        },
        { kind: 'row', left: 'Papel', right: `${printer.paperWidth} mm` },
        { kind: 'text', text: new Date().toLocaleString('es-CO'), align: 'center', size: 'sm' },
        { kind: 'feed', lines: 1 },
        { kind: 'text', text: 'Lynko POS', align: 'center', size: 'sm' },
        { kind: 'cut' },
      ],
    };
    return this.printJobs.enqueue({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      createdByUserId: ctx.userId,
      document,
      printerId: printer.id,
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
