import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PrintDocumentType,
  PrinterConnection,
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

const DEFAULT_CANCEL_REASON = 'CANCELLED_BY_USER';

/**
 * Un job pendiente caduca a los 15 min: una comanda de cocina vieja no debe
 * imprimirse nunca (y sin esta ventana el agente reenvía la misma cola muerta
 * en cada poll, que fue lo que disparó el egress de Supabase).
 */
const PENDING_TTL_MS = Number(process.env.PRINT_JOB_TTL_MS ?? 15 * 60_000);
/** Retención del histórico (ACK/FAILED) antes de purgarse. */
const HISTORY_RETENTION_DAYS = Number(
  process.env.PRINT_JOB_RETENTION_DAYS ?? 30,
);
/** Máximo de jobs devueltos por poll: cota dura al tamaño de la respuesta. */
const PENDING_PAGE_SIZE = 50;
/** Frecuencia máxima del mantenimiento best-effort disparado por el polling. */
const MAINTENANCE_INTERVAL_MS = 5 * 60_000;
const EXPIRED_REASON = 'EXPIRED_TTL';

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
  private readonly logger = new Logger(PrintJobsService.name);
  private lastMaintenanceAt = 0;

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
   *
   * Solo devuelve los encolados dentro de la ventana `PENDING_TTL_MS`: lo más
   * viejo se considera caducado y nunca se imprime. Aprovecha el poll para
   * lanzar el mantenimiento (caducar + purgar) sin depender de un cron.
   */
  async findPending(ctx: TenantContext) {
    void this.runMaintenance();
    const jobs = await this.prisma.printJob.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        status: PrintJobStatus.QUEUED,
        createdAt: { gte: new Date(Date.now() - PENDING_TTL_MS) },
      },
      take: PENDING_PAGE_SIZE,
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

  /**
   * Mantenimiento best-effort disparado por el propio polling (así no hace
   * falta `@nestjs/schedule` ni un worker aparte): marca como FAILED los
   * pendientes caducados y borra el histórico más viejo que la retención.
   * Corre como mucho una vez cada `MAINTENANCE_INTERVAL_MS` por instancia y
   * nunca rompe la petición del agente si falla.
   */
  private async runMaintenance() {
    const now = Date.now();
    if (now - this.lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return;
    this.lastMaintenanceAt = now;

    try {
      const expired = await this.prisma.printJob.updateMany({
        where: {
          status: PrintJobStatus.QUEUED,
          createdAt: { lt: new Date(now - PENDING_TTL_MS) },
        },
        data: { status: PrintJobStatus.FAILED, lastError: EXPIRED_REASON },
      });

      const purged = await this.prisma.printJob.deleteMany({
        where: {
          status: { in: [PrintJobStatus.ACK, PrintJobStatus.FAILED] },
          createdAt: {
            lt: new Date(now - HISTORY_RETENTION_DAYS * 24 * 60 * 60_000),
          },
        },
      });

      if (expired.count || purged.count) {
        this.logger.log(
          `Mantenimiento print jobs: ${expired.count} caducados, ${purged.count} purgados`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Mantenimiento de print jobs falló: ${(err as Error).message}`,
      );
    }
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

  async cancel(ctx: TenantContext, id: string, reason?: string) {
    const existing = await this.assertJob(ctx, id);
    if (existing.status !== PrintJobStatus.QUEUED) {
      return this.mapJob(existing);
    }
    const job = await this.prisma.printJob.update({
      where: { id },
      data: {
        status: PrintJobStatus.FAILED,
        lastError: reason?.trim() || DEFAULT_CANCEL_REASON,
      },
    });
    return this.mapJob(job);
  }

  async cancelPending(ctx: TenantContext, reason?: string) {
    const result = await this.prisma.printJob.updateMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        status: PrintJobStatus.QUEUED,
      },
      data: {
        status: PrintJobStatus.FAILED,
        lastError: reason?.trim() || DEFAULT_CANCEL_REASON,
      },
    });
    return { cancelled: result.count };
  }

  // Cancela los jobs EN COLA (QUEUED) de una orden concreta, filtrando por el
  // `meta.orderId` guardado dentro del PrintDocument (payload JSON). Se llama al
  // cerrar/anular la orden para que el agente Lynko no imprima comandas/facturas
  // colgadas de una orden ya finalizada — que quede en cola solo lo real.
  async cancelByOrder(ctx: TenantContext, orderId: string, reason?: string) {
    if (!orderId?.trim()) return { cancelled: 0 };
    const result = await this.prisma.printJob.updateMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        status: PrintJobStatus.QUEUED,
        payload: { path: ['meta', 'orderId'], equals: orderId },
      },
      data: {
        status: PrintJobStatus.FAILED,
        lastError: reason?.trim() || 'Orden finalizada',
      },
    });
    return { cancelled: result.count };
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
        where: {
          id: params.printerId,
          tenantId,
          branchId,
          isActive: true,
          connection: { in: [PrinterConnection.NETWORK, PrinterConnection.AGENT] },
        },
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
      where: {
        tenantId,
        branchId,
        target,
        isActive: true,
        connection: { in: [PrinterConnection.NETWORK, PrinterConnection.AGENT] },
      },
      select: { id: true },
    });
    if (direct.length > 0) return direct;
    if (target === PrinterTarget.DEFAULT) return [];
    return this.prisma.printer.findMany({
      where: {
        tenantId,
        branchId,
        target: PrinterTarget.DEFAULT,
        isActive: true,
        connection: { in: [PrinterConnection.NETWORK, PrinterConnection.AGENT] },
      },
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
    const existing = await this.prisma.printJob.findUnique({
      where: {
        tenantId_branchId_documentId: {
          tenantId: args.tenantId,
          branchId: args.branchId,
          documentId: args.documentId,
        },
      },
    });

    // No existe → crear.
    if (!existing) {
      return this.prisma.printJob.create({
        data: {
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

    // Ya existe y sigue EN COLA → idempotente: no duplicar (evita reimpresiones
    // dobles al re-enviar el mismo documento mientras aún no se imprime).
    if (existing.status === PrintJobStatus.QUEUED) return existing;

    // Ya existe pero TERMINÓ (impreso o fallido) → es una re-impresión legítima:
    // re-encolar con el payload nuevo, sin bloquear. Así "generar de nuevo la
    // factura" tras cerrar la orden siempre funciona.
    return this.prisma.printJob.update({
      where: { id: existing.id },
      data: {
        printerId: args.printerId,
        payload,
        status: args.status,
        lastError: args.lastError ?? null,
        attempts: 0,
        sentAt: null,
        acknowledgedAt: null,
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
