import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PrintDocumentType,
  PrinterTarget,
  PrintJob,
  PrintJobStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrintDocument } from './printing.types';
import { CreatePrintJobDto } from './dto/print-job.dto';

/** Target por defecto según el tipo de documento (routing por target, no por id). */
const TARGET_BY_DOC: Record<PrintDocumentType, PrinterTarget> = {
  KITCHEN_TICKET: PrinterTarget.KITCHEN,
  RECEIPT: PrinterTarget.CASHIER,
  Z_REPORT: PrinterTarget.CASHIER,
  X_REPORT: PrinterTarget.CASHIER,
  EXPENSE_VOUCHER: PrinterTarget.CASHIER,
};

export interface EnqueueParams {
  tenantId: string;
  branchId: string;
  createdByUserId?: string | null;
  document: PrintDocument;
  printerId?: string | null;
  target?: PrinterTarget;
}

@Injectable()
export class PrintJobsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Lecturas ────────────────────────────────────────────────────────────
  async findAll(
    ctx: TenantContext,
    status?: string,
    from?: string,
    to?: string,
  ) {
    const jobs = await this.prisma.printJob.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        ...(status ? { status: status as PrintJobStatus } : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return { jobs: jobs.map((j) => this.mapJob(j)) };
  }

  /**
   * Jobs encolados para el agente local. Incluye los datos de la impresora
   * (conexión, ip, puerto, papel) para que el agente sepa a dónde abrir el TCP.
   */
  async findPending(ctx: TenantContext) {
    const jobs = await this.prisma.printJob.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        status: PrintJobStatus.QUEUED,
      },
      include: {
        printer: {
          select: {
            id: true,
            name: true,
            target: true,
            connection: true,
            ipAddress: true,
            port: true,
            paperWidth: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      jobs: jobs.map((j) => ({
        ...this.mapJob(j),
        printer: j.printer
          ? {
              id: j.printer.id,
              name: j.printer.name,
              target: j.printer.target,
              connection: j.printer.connection,
              ipAddress: j.printer.ipAddress ?? undefined,
              port: j.printer.port ?? undefined,
              paperWidth: j.printer.paperWidth,
            }
          : undefined,
      })),
    };
  }

  // ─── Transiciones de estado (agente local) ───────────────────────────────
  async ack(ctx: TenantContext, id: string) {
    await this.assertJob(ctx, id);
    const job = await this.prisma.printJob.update({
      where: { id },
      data: { status: PrintJobStatus.ACK, acknowledgedAt: new Date() },
    });
    return this.mapJob(job);
  }

  async fail(ctx: TenantContext, id: string, error: string) {
    const existing = await this.assertJob(ctx, id);
    const job = await this.prisma.printJob.update({
      where: { id },
      data: {
        status: PrintJobStatus.FAILED,
        lastError: error,
        attempts: existing.attempts + 1,
      },
    });
    return this.mapJob(job);
  }

  async retry(ctx: TenantContext, id: string) {
    const existing = await this.assertJob(ctx, id);
    if (!existing.printerId)
      throw new UnprocessableEntityException(
        'Job has no printer assigned; nothing to retry',
      );
    const job = await this.prisma.printJob.update({
      where: { id },
      data: { status: PrintJobStatus.QUEUED, lastError: null },
    });
    return this.mapJob(job);
  }

  // ─── Creación desde request directo del front ────────────────────────────
  async createFromRequest(ctx: TenantContext, dto: CreatePrintJobDto) {
    const jobs = await this.enqueue({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      createdByUserId: ctx.userId,
      document: dto.document,
      printerId: dto.printerId ?? null,
    });
    return { jobs: jobs.map((j) => this.mapJob(j)) };
  }

  /** Shape del contrato FE (Anexo A §A2): `document` (no `payload`), fechas ISO. */
  private mapJob(job: PrintJob) {
    return {
      id: job.id,
      tenantId: job.tenantId,
      branchId: job.branchId,
      printerId: job.printerId ?? undefined,
      documentType: job.documentType,
      document: job.payload as unknown as PrintDocument,
      status: job.status,
      attempts: job.attempts,
      lastError: job.lastError ?? undefined,
      createdAt: job.createdAt.toISOString(),
      sentAt: job.sentAt?.toISOString() ?? undefined,
      acknowledgedAt: job.acknowledgedAt?.toISOString() ?? undefined,
    };
  }

  /**
   * Encola un documento. Idempotente por `(tenant, branch, documentId)` — al
   * abanicar por varias impresoras se sufija el documentId con el printerId.
   * Si no hay impresora activa para el target → un job FAILED (el front hace
   * preview / `window.print`).
   */
  async enqueue(params: EnqueueParams) {
    const { tenantId, branchId, document } = params;

    let printers: Array<{ id: string }> = [];
    if (params.printerId) {
      const printer = await this.prisma.printer.findFirst({
        where: { id: params.printerId, tenantId, branchId, isActive: true },
        select: { id: true },
      });
      if (!printer)
        throw new NotFoundException(`Printer ${params.printerId} not found`);
      printers = [printer];
    } else {
      const target = params.target ?? TARGET_BY_DOC[document.type];
      printers = await this.resolvePrintersByTarget(tenantId, branchId, target);
    }

    // Sin impresora → job FAILED para que el front muestre preview.
    if (printers.length === 0) {
      const job = await this.upsertJob({
        tenantId,
        branchId,
        printerId: null,
        documentId: document.id,
        document,
        createdByUserId: params.createdByUserId,
        status: PrintJobStatus.FAILED,
        lastError: 'NO_ACTIVE_PRINTER',
      });
      return [job];
    }

    const jobs: PrintJob[] = [];
    for (const printer of printers) {
      const documentId =
        printers.length > 1
          ? `${document.id}:${printer.id}`
          : document.id;
      jobs.push(
        await this.upsertJob({
          tenantId,
          branchId,
          printerId: printer.id,
          documentId,
          document,
          createdByUserId: params.createdByUserId,
          status: PrintJobStatus.QUEUED,
        }),
      );
    }
    return jobs;
  }

  private async resolvePrintersByTarget(
    tenantId: string,
    branchId: string,
    target: PrinterTarget,
  ) {
    const direct = await this.prisma.printer.findMany({
      where: { tenantId, branchId, target, isActive: true },
      select: { id: true },
    });
    if (direct.length > 0) return direct;
    if (target === PrinterTarget.DEFAULT) return [];
    return this.prisma.printer.findMany({
      where: { tenantId, branchId, target: PrinterTarget.DEFAULT, isActive: true },
      select: { id: true },
    });
  }

  private async upsertJob(args: {
    tenantId: string;
    branchId: string;
    printerId: string | null;
    documentId: string;
    document: PrintDocument;
    createdByUserId?: string | null;
    status: PrintJobStatus;
    lastError?: string;
  }) {
    const payload = args.document as unknown as Prisma.InputJsonValue;
    return this.prisma.printJob.upsert({
      where: {
        tenantId_branchId_documentId: {
          tenantId: args.tenantId,
          branchId: args.branchId,
          documentId: args.documentId,
        },
      },
      // Idempotente: si ya existe el documento, no se duplica ni se re-encola.
      update: {},
      create: {
        tenantId: args.tenantId,
        branchId: args.branchId,
        printerId: args.printerId,
        documentType: args.document.type,
        documentId: args.documentId,
        payload,
        status: args.status,
        lastError: args.lastError,
        createdByUserId: args.createdByUserId ?? null,
      },
    });
  }

  private async assertJob(ctx: TenantContext, id: string) {
    const job = await this.prisma.printJob.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
    if (!job) throw new NotFoundException(`Print job ${id} not found`);
    return job;
  }
}
